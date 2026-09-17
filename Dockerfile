FROM node:20-slim

# Instalar dependencias del sistema: Python3, FFmpeg y Curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Descargar la versión más reciente de yt-dlp directamente desde GitHub
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Configurar usuario sin privilegios para Hugging Face Spaces (UID 1000)
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    PORT=7860

WORKDIR /home/user/app

# Instalar dependencias de Node.js
COPY --chown=user:user package*.json ./
RUN npm install --production

# Copiar el código de la aplicación
COPY --chown=user:user . .

# Crear el directorio de almacenamiento de música
RUN mkdir -p /home/user/Music/MusicBox

EXPOSE 7860

CMD ["node", "server.js"]
