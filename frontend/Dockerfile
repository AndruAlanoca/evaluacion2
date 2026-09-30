FROM nginx:alpine

# Copiar configuración del Proxy Reverso
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copiar los archivos estáticos
COPY . /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]