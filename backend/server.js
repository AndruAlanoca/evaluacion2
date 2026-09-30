const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const app = express();
app.use(express.json());

// Configuración de PostgreSQL
const pool = new Pool({
  host: process.env.PGHOST || 'host.docker.internal',
  port: parseInt(process.env.PGPORT || '5432'),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'CatalogoProductos',
});

// Configuración de clientes AWS SDK v3 apuntando a LocalStack
const awsConfig = {
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT || 'http://host.docker.internal:4566',
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
  forcePathStyle: true,
};

const s3Client = new S3Client(awsConfig);
const ddbRawClient = new DynamoDBClient(awsConfig);
const ddbDocClient = DynamoDBDocumentClient.from(ddbRawClient);
const lambdaClient = new LambdaClient(awsConfig);

// Configuración de Multer en memoria (Máximo 5 MB)
const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

// ==========================================
// ENDPOINTS
// ==========================================

// GET /categorias
app.get('/categorias', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categorias ORDER BY categoria_id;');
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error en GET /categorias:', err);
    return res.status(500).json({ error: 'Error al consultar categorías' });
  }
});

// POST /productos
app.post('/productos', async (req, res) => {
  const { codigo, nombre, descripcion, precio, categoria_id, atributos } = req.body;

  // Validaciones de entrada
  if (!codigo || !nombre || precio === undefined || !categoria_id) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }

  if (typeof precio !== 'number' || precio <= 0) {
    return res.status(400).json({ error: 'El precio debe ser un número positivo' });
  }

  try {
    // 1. Validar categoría en RDS
    const catCheck = await pool.query('SELECT categoria_id FROM categorias WHERE categoria_id = $1', [categoria_id]);
    if (catCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Categoría inexistente' });
    }

    // 2. Validar duplicados de código en RDS
    const prodCheck = await pool.query('SELECT producto_id FROM productos WHERE producto_id = $1', [codigo]);
    if (prodCheck.rows.length > 0) {
      return res.status(409).json({ error: 'Código de producto duplicado' });
    }

    // 3. Insertar producto PENDIENTE en RDS
    await pool.query(
      'INSERT INTO productos (producto_id, nombre, descripcion, precio, categoria_id, estado) VALUES ($1, $2, $3, $4, $5, $6)',
      [codigo, nombre, descripcion || '', precio, categoria_id, 'PENDIENTE']
    );

    // 4. Insertar atributos en DynamoDB
    const ddbItem = {
      producto_id: codigo,
      ...(atributos || {}),
    };

    await ddbDocClient.send(
      new PutCommand({
        TableName: 'ProductosAtributos',
        Item: ddbItem,
      })
    );

    return res.status(201).json({
      producto_id: codigo,
      estado: 'PENDIENTE',
    });
  } catch (err) {
    console.error('Error en POST /productos:', err);
    return res.status(502).json({ error: 'Error al procesar almacenamiento de producto' });
  }
});

// Middleware Multer con manejo de errores de tamaño de archivo (413)
const uploadSingle = (req, res, next) => {
  upload.single('imagen')(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'El archivo supera el tamaño máximo permitido de 5 MB' });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }
    next();
  });
};

// POST /productos/:id/imagen
app.post('/productos/:id/imagen', uploadSingle, async (req, res) => {
  const producto_id = req.params.id;

  if (!req.file) {
    return res.status(400).json({ error: 'Se requiere un archivo de imagen en el campo "imagen"' });
  }

  // Validación de formato (jpg, jpeg, png)
  const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png'];
  if (!allowedMimeTypes.includes(req.file.mimetype)) {
    return res.status(415).json({ error: 'Formato no permitido. Solo se aceptan JPEG y PNG.' });
  }

  try {
    // Verificar que el producto exista en RDS
    const prodCheck = await pool.query('SELECT producto_id FROM productos WHERE producto_id = $1', [producto_id]);
    if (prodCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    // Extensión del archivo
    const ext = req.file.mimetype === 'image/png' ? 'png' : 'jpg';
    const s3Key = `originales/${producto_id}.${ext}`;

    // 1. Guardar en S3 catalogo-originales
    await s3Client.send(
      new PutObjectCommand({
        Bucket: 'catalogo-originales',
        Key: s3Key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      })
    );

    // 2. Invocar Lambda GenerarMiniatura
    const payloadBytes = Buffer.from(
      JSON.stringify({
        producto_id: producto_id,
        bucket: 'catalogo-originales',
        key: s3Key,
      })
    );

    const lambdaResult = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: 'GenerarMiniatura',
        Payload: payloadBytes,
      })
    );

    const responsePayload = JSON.parse(Buffer.from(lambdaResult.Payload).toString('utf-8'));

    if (responsePayload.status !== 'OK') {
      return res.status(502).json({
        error: 'Fallo al generar miniatura',
        paso_fallido: 'Lambda GenerarMiniatura',
        detalle: responsePayload.message,
      });
    }

    // 3. Verificar estado en DynamoDB
    const ddbGet = await ddbDocClient.send(
      new GetCommand({
        TableName: 'ProductosAtributos',
        Key: { producto_id: producto_id },
      })
    );

    if (!ddbGet.Item || ddbGet.Item.estado !== 'LISTA') {
      return res.status(502).json({
        error: 'Los atributos en DynamoDB no fueron actualizados a estado LISTA por la Lambda',
        paso_fallido: 'Verificación DynamoDB',
      });
    }

    // 4. Actualizar estado en PostgreSQL a PUBLICADO
    await pool.query('UPDATE productos SET estado = $1 WHERE producto_id = $2', ['PUBLICADO', producto_id]);

    return res.status(200).json({
      producto_id: producto_id,
      estado: 'PUBLICADO',
    });
  } catch (err) {
    console.error('Error en POST /productos/:id/imagen:', err);
    return res.status(503).json({ error: 'Fallo de servicio dependiente', detalle: err.message });
  }
});

// POST /productos/:id/reprocesar
app.post('/productos/:id/reprocesar', async (req, res) => {
  const producto_id = req.params.id;

  try {
    // 1. Buscar en S3 si existe la imagen original (probando .jpg y .png)
    let s3Key = null;
    for (const ext of ['jpg', 'png', 'jpeg']) {
      try {
        const keyTest = `originales/${producto_id}.${ext}`;
        await s3Client.send(
          new HeadObjectCommand({
            Bucket: 'catalogo-originales',
            Key: keyTest,
          })
        );
        s3Key = keyTest;
        break;
      } catch (e) {
        // Objeto no encontrado, continuar prueba
      }
    }

    if (!s3Key) {
      return res.status(409).json({ error: 'Imagen original inexistente' });
    }

    // 2. Invocar Lambda nuevamente
    const payloadBytes = Buffer.from(
      JSON.stringify({
        producto_id: producto_id,
        bucket: 'catalogo-originales',
        key: s3Key,
      })
    );

    const lambdaResult = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: 'GenerarMiniatura',
        Payload: payloadBytes,
      })
    );

    const responsePayload = JSON.parse(Buffer.from(lambdaResult.Payload).toString('utf-8'));

    if (responsePayload.status !== 'OK') {
      return res.status(502).json({
        error: 'Fallo al reprocesar miniatura',
        paso_fallido: 'Lambda GenerarMiniatura',
        detalle: responsePayload.message,
      });
    }

    // 3. Actualizar estado a PUBLICADO
    await pool.query('UPDATE productos SET estado = $1 WHERE producto_id = $2', ['PUBLICADO', producto_id]);

    return res.status(200).json({
      producto_id: producto_id,
      estado: 'PUBLICADO',
    });
  } catch (err) {
    console.error('Error en POST /productos/:id/reprocesar:', err);
    return res.status(503).json({ error: 'Error en servicio al reprocesar', detalle: err.message });
  }
});

// GET /productos (Solo publicados)
app.get('/productos', async (req, res) => {
  try {
    const pgResult = await pool.query("SELECT * FROM productos WHERE estado = 'PUBLICADO';");
    const productos = [];

    for (const prod of pgResult.rows) {
      // Consultar DynamoDB para obtener atributos y la referencia de la miniatura
      const ddbGet = await ddbDocClient.send(
        new GetCommand({
          TableName: 'ProductosAtributos',
          Key: { producto_id: prod.producto_id },
        })
      );

      const ddbItem = ddbGet.Item || {};

      productos.push({
        producto_id: prod.producto_id,
        nombre: prod.nombre,
        descripcion: prod.descripcion,
        precio: parseFloat(prod.precio),
        categoria_id: prod.categoria_id,
        estado: prod.estado,
        miniatura: ddbItem.miniatura || `miniaturas/${prod.producto_id}_thumb.jpg`,
        atributos: ddbItem,
      });
    }

    return res.status(200).json(productos);
  } catch (err) {
    console.error('Error en GET /productos:', err);
    return res.status(500).json({ error: 'Error al consultar lista de productos' });
  }
});

// GET /productos/:id
app.get('/productos/:id', async (req, res) => {
  const producto_id = req.params.id;

  try {
    const pgResult = await pool.query('SELECT * FROM productos WHERE producto_id = $1;', [producto_id]);

    if (pgResult.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    const prod = pgResult.rows[0];

    // Consultar DynamoDB
    const ddbGet = await ddbDocClient.send(
      new GetCommand({
        TableName: 'ProductosAtributos',
        Key: { producto_id: producto_id },
      })
    );

    return res.status(200).json({
      producto_id: prod.producto_id,
      nombre: prod.nombre,
      descripcion: prod.descripcion,
      precio: parseFloat(prod.precio),
      categoria_id: prod.categoria_id,
      estado: prod.estado,
      atributos: ddbGet.Item || {},
    });
  } catch (err) {
    console.error('Error en GET /productos/:id:', err);
    return res.status(500).json({ error: 'Error al consultar producto' });
  }
});

// GET /productos/:id/imagen
app.get('/productos/:id/imagen', async (req, res) => {
  const producto_id = req.params.id;

  // Probar llaves posibles en catalogo-miniaturas
  const possibleKeys = [
    `miniaturas/${producto_id}_thumb.jpg`,
    `miniaturas/${producto_id}_thumb.png`,
    `miniaturas/${producto_id}_thumb.jpeg`,
  ];

  for (const key of possibleKeys) {
    try {
      const s3Obj = await s3Client.send(
        new GetObjectCommand({
          Bucket: 'catalogo-miniaturas',
          Key: key,
        })
      );

      const contentType = s3Obj.ContentType || (key.endsWith('.png') ? 'image/png' : 'image/jpeg');
      res.setHeader('Content-Type', contentType);

      // Transmitir el flujo de bytes directamente al cliente
      return s3Obj.Body.pipe(res);
    } catch (e) {
      // Continuar al siguiente si no existe
    }
  }

  return res.status(404).json({ error: 'Miniatura no encontrada' });
});

// Puerto de la aplicación
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend API escuchando en el puerto ${PORT}`);
});