import boto3
from PIL import Image
import os

def lambda_handler(event, context):

    producto_id = event["producto_id"]
    bucket = event["bucket"]
    key = event["key"]

    s3 = boto3.client("s3")
    dynamodb = boto3.resource("dynamodb")

    table = dynamodb.Table("ProductosAtributos")

    try:

        filename = "/tmp/original"

        s3.download_file(bucket, key, filename)

        image = Image.open(filename)

        width, height = image.size

        image.thumbnail((300,300))

        if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
            rgba = image.convert("RGBA")
            background = Image.new("RGB", rgba.size, (255, 255, 255))
            background.paste(rgba, mask=rgba.getchannel("A"))
            image = background
        elif image.mode != "RGB":
            image = image.convert("RGB")

        output_file = "/tmp/thumb.jpg"

        image.save(output_file, format="JPEG", quality=85)

        salida = f"miniaturas/{producto_id}_thumb.jpg"

        s3.upload_file(
            output_file,
            "catalogo-miniaturas",
            salida,
            ExtraArgs={"ContentType": "image/jpeg"}
        )

        table.update_item(
            Key={
                "producto_id": producto_id
            },
            UpdateExpression=
                "SET estado=:e, miniatura=:m",
            ExpressionAttributeValues={
                ":e":"LISTA",
                ":m":salida
            }
        )

        return {
            "status":"OK",
            "thumbnail":salida
        }

    except Exception as e:

        table.update_item(
            Key={
                "producto_id": producto_id
            },
            UpdateExpression=
                "SET estado=:e",
            ExpressionAttributeValues={
                ":e":"ERROR"
            }
        )

        return {
            "status":"ERROR",
            "message":str(e)
        }