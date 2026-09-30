const API_URL = '/api';
let categoriasMap = {};

document.addEventListener('DOMContentLoaded', () => {
  cargarCategorias();
  cargarCatalogo();
});

function showSection(section) {
  document.getElementById('sec-catalogo').classList.toggle('hidden', section !== 'catalogo');
  document.getElementById('sec-registro').classList.toggle('hidden', section !== 'registro');
  if (section === 'catalogo') cargarCatalogo();
}

function showAlert(message, type = 'error') {
  const alertBox = document.getElementById('alertBox');
  alertBox.classList.remove('hidden', 'bg-red-100', 'text-red-700', 'bg-green-100', 'text-green-700', 'bg-amber-100', 'text-amber-700');
  
  if (type === 'error') alertBox.classList.add('bg-red-100', 'text-red-700');
  else if (type === 'success') alertBox.classList.add('bg-green-100', 'text-green-700');
  else alertBox.classList.add('bg-amber-100', 'text-amber-700');

  alertBox.innerText = message;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function hideAlert() {
  document.getElementById('alertBox').classList.add('hidden');
}

// Cargar categorías en el <select> del formulario
async function cargarCategorias() {
  try {
    const res = await fetch(`${API_URL}/categorias`);
    const data = await res.json();
    const select = document.getElementById('p_categoria');
    select.innerHTML = '<option value="">Seleccione una categoría</option>';
    
    data.forEach(cat => {
      categoriasMap[cat.categoria_id] = cat.nombre;
      select.innerHTML += `<option value="${cat.categoria_id}">${cat.nombre}</option>`;
    });
  } catch (err) {
    showAlert('Error al conectar con la API de categorías', 'error');
  }
}

// Vista 1: Cargar grilla del Catálogo
async function cargarCatalogo() {
  hideAlert();
  const grid = document.getElementById('grid-productos');
  grid.innerHTML = '<p class="col-span-full text-center text-gray-500 py-8">Cargando catálogo...</p>';

  try {
    const res = await fetch(`${API_URL}/productos`);
    const productos = await res.json();

    if (productos.length === 0) {
      grid.innerHTML = '<p class="col-span-full text-center text-gray-500 py-8">No hay productos publicados en el catálogo.</p>';
      return;
    }

    grid.innerHTML = productos.map(prod => `
      <div class="bg-white border rounded-lg overflow-hidden shadow-sm hover:shadow-md transition">
        <img src="${API_URL}/productos/${prod.producto_id}/imagen" alt="${prod.nombre}" class="w-full h-48 object-cover bg-gray-200" onerror="this.src='https://via.placeholder.com/300x200?text=Sin+Miniatura'">
        <div class="p-4">
          <span class="text-xs bg-indigo-100 text-indigo-800 px-2 py-1 rounded font-semibold">${categoriasMap[prod.categoria_id] || 'Cat #' + prod.categoria_id}</span>
          <h3 class="font-bold text-lg mt-2">${prod.nombre}</h3>
          <p class="text-gray-600 font-bold text-md mt-1">Bs. ${prod.precio.toFixed(2)}</p>
          <button onclick="verDetalle('${prod.producto_id}')" class="mt-4 w-full bg-indigo-50 text-indigo-600 py-1.5 rounded font-semibold hover:bg-indigo-100 text-sm">Ver Detalle</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    grid.innerHTML = '<p class="col-span-full text-center text-red-500 py-8">Error al cargar productos del catálogo.</p>';
  }
}

// Atributos dinámicos Key-Value
function agregarCampoAtributo() {
  const container = document.getElementById('contenedor-atributos');
  const div = document.createElement('div');
  div.className = 'flex space-x-2 attr-row';
  div.innerHTML = `
    <input type="text" placeholder="Clave" class="border p-2 rounded w-1/2 attr-key">
    <input type="text" placeholder="Valor" class="border p-2 rounded w-1/2 attr-value">
  `;
  container.appendChild(div);
}

// Vista 2: Registrar Producto (Post + Subida de Imagen)
async function handleRegistro(e) {
  e.preventDefault();
  hideAlert();
  document.getElementById('panel-reintento').classList.add('hidden');

  const codigo = document.getElementById('p_codigo').value.trim();
  const nombre = document.getElementById('p_nombre').value.trim();
  const descripcion = document.getElementById('p_descripcion').value.trim();
  const precio = parseFloat(document.getElementById('p_precio').value);
  const categoria_id = parseInt(document.getElementById('p_categoria').value);
  const fileInput = document.getElementById('p_imagen');

  // Validaciones del cliente
  if (fileInput.files.length === 0) return showAlert('Debe seleccionar una imagen', 'error');
  const file = fileInput.files[0];

  if (file.size > 5 * 1024 * 1024) return showAlert('Error 413: El archivo supera el tamaño máximo de 5MB', 'error');
  if (!['image/jpeg', 'image/jpg', 'image/png'].includes(file.type)) return showAlert('Error 415: Formato de archivo no soportado (Solo JPG/PNG)', 'error');

  // Recopilar atributos dinámicos
  const atributos = {};
  document.querySelectorAll('.attr-row').forEach(row => {
    const k = row.querySelector('.attr-key').value.trim();
    const v = row.querySelector('.attr-value').value.trim();
    if (k && v) atributos[k] = v;
  });

  const btnGuardar = document.getElementById('btn-guardar');
  btnGuardar.disabled = true;
  btnGuardar.innerText = 'Guardando...';

  try {
    // Paso 1: Crear producto PENDIENTE
    const resProd = await fetch(`${API_URL}/productos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codigo, nombre, descripcion, precio, categoria_id, atributos })
    });

    if (resProd.status === 409) throw new Error('409: Código de producto ya existe en la base de datos');
    if (resProd.status === 400) throw new Error('400: Datos de entrada inválidos');
    if (!resProd.ok) throw new Error(`Error en servidor (${resProd.status})`);

    // Paso 2: Subir imagen e invocar Lambda
    btnGuardar.innerText = 'Procesando imagen...';
    const formData = new FormData();
    formData.append('imagen', file);

    const resImg = await fetch(`${API_URL}/productos/${codigo}/imagen`, {
      method: 'POST',
      body: formData
    });

    if (!resImg.ok) {
      const errImg = await resImg.json();
      // Mostrar panel de reintento
      configurarReintento(codigo, errImg.error || 'Fallo en procesamiento de imagen');
      throw new Error(`Fallo procesamiento de imagen: ${errImg.error || resImg.statusText}`);
    }

    showAlert(`Producto ${codigo} registrado y publicado exitosamente`, 'success');
    document.getElementById('form-producto').reset();
    setTimeout(() => showSection('catalogo'), 1500);

  } catch (err) {
    showAlert(err.message, 'error');
  } finally {
    btnGuardar.disabled = false;
    btnGuardar.innerText = 'Guardar y Publicar';
  }
}

function configurarReintento(codigo, mensaje) {
  const panel = document.getElementById('panel-reintento');
  const txt = document.getElementById('txt-reintento-msg');
  const btn = document.getElementById('btn-reintentar');

  txt.innerText = `El producto fue registrado pero la imagen falló: ${mensaje}`;
  panel.classList.remove('hidden');

  btn.onclick = async () => {
    btn.disabled = true;
    btn.innerText = 'Reprocesando...';
    try {
      const res = await fetch(`${API_URL}/productos/${codigo}/reprocesar`, { method: 'POST' });
      if (!res.ok) throw new Error('Error al reprocesar imagen');
      showAlert(`Producto ${codigo} reprocesado e imagen actualizada a PUBLICADO`, 'success');
      panel.classList.add('hidden');
      setTimeout(() => showSection('catalogo'), 1500);
    } catch (e) {
      showAlert(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerText = 'Reintentar Procesamiento de Imagen';
    }
  };
}

// Vista 3: Ver Detalle del Producto (Modal)
async function verDetalle(id) {
  const modal = document.getElementById('modal-detalle');
  const contenedor = document.getElementById('detalle-contenido');
  contenedor.innerHTML = '<p class="text-center py-4">Cargando detalle...</p>';
  modal.classList.remove('hidden');

  try {
    const res = await fetch(`${API_URL}/productos/${id}`);
    if (!res.ok) throw new Error('Producto no encontrado');
    const prod = await res.json();

    // Renderizar atributos dinámicos
    const attrsHtml = Object.entries(prod.atributos || {})
      .filter(([k]) => !['producto_id', 'estado', 'miniatura'].includes(k))
      .map(([k, v]) => `<li class="text-sm"><strong>${k}:</strong> ${v}</li>`)
      .join('');

    contenedor.innerHTML = `
      <img src="${API_URL}/productos/${prod.producto_id}/imagen" class="w-full h-56 object-cover rounded mb-4" alt="${prod.nombre}">
      <span class="text-xs bg-indigo-100 text-indigo-800 px-2 py-1 rounded font-semibold">${categoriasMap[prod.categoria_id] || 'Categoría #' + prod.categoria_id}</span>
      <h3 class="text-2xl font-bold mt-2">${prod.nombre}</h3>
      <p class="text-sm text-gray-500 font-mono mt-1">ID: ${prod.producto_id} | Estado: <span class="font-bold text-green-600">${prod.estado}</span></p>
      <p class="text-2xl font-bold text-indigo-700 mt-2">Bs. ${prod.precio.toFixed(2)}</p>
      <div class="mt-4 border-t pt-2">
        <h4 class="font-semibold text-gray-700">Descripción:</h4>
        <p class="text-gray-600 text-sm mt-1">${prod.descripcion || 'Sin descripción'}</p>
      </div>
      <div class="mt-4 border-t pt-2">
        <h4 class="font-semibold text-gray-700">Atributos (DynamoDB):</h4>
        <ul class="list-disc list-inside mt-1 text-gray-600">
          ${attrsHtml || '<li class="text-sm italic">Sin atributos adicionales</li>'}
        </ul>
      </div>
    `;
  } catch (err) {
    contenedor.innerHTML = `<p class="text-red-500 text-center py-4">${err.message}</p>`;
  }
}

function cerrarModal() {
  document.getElementById('modal-detalle').classList.add('hidden');
}