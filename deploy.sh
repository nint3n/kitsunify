#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# 🎵 MusicBox + Jellyfin — Despliegue automático en VPS Ubuntu
# ═══════════════════════════════════════════════════════════════
#
# Uso:
#   curl -fsSL https://raw.githubusercontent.com/TU_USUARIO/musicbox/main/deploy.sh | bash
#   — o —
#   bash deploy.sh
#
# Esto instala: Node.js, yt-dlp, FFmpeg, Jellyfin, PM2
# y configura MusicBox para arrancar automáticamente.
# ═══════════════════════════════════════════════════════════════

set -e

GREEN='\033[0;32m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

log() { echo -e "${GREEN}[MusicBox]${NC} $1"; }
logp() { echo -e "${PURPLE}[MusicBox]${NC} $1"; }

echo ""
echo -e "${PURPLE}${BOLD}"
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║                                              ║"
echo "  ║   🎵  MusicBox + Jellyfin Installer          ║"
echo "  ║       VPS Auto-Deploy Script                 ║"
echo "  ║                                              ║"
echo "  ╚══════════════════════════════════════════════╝"
echo -e "${NC}"

# ─── 1. Update system ────────────────────────────────────────────
log "Actualizando sistema operativo..."
sudo apt update && sudo apt upgrade -y

# ─── 2. Install system dependencies ──────────────────────────────
log "Instalando dependencias del sistema..."
sudo apt install -y curl git ffmpeg python3 unzip

# ─── 3. Install Node.js LTS ──────────────────────────────────────
if command -v node &> /dev/null; then
  log "Node.js ya instalado: $(node --version)"
else
  log "Instalando Node.js LTS..."
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt install -y nodejs
  log "Node.js instalado: $(node --version)"
fi

# ─── 4. Install yt-dlp ───────────────────────────────────────────
if command -v yt-dlp &> /dev/null; then
  log "yt-dlp ya instalado: $(yt-dlp --version)"
else
  log "Instalando yt-dlp..."
  sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  sudo chmod a+rx /usr/local/bin/yt-dlp
  log "yt-dlp instalado: $(yt-dlp --version)"
fi

# ─── 5. Install Jellyfin ─────────────────────────────────────────
if systemctl is-active --quiet jellyfin 2>/dev/null; then
  log "Jellyfin ya está corriendo"
else
  log "Instalando Jellyfin..."
  curl https://repo.jellyfin.org/install-debuntu.sh | sudo bash
  log "Jellyfin instalado y corriendo"
fi

# ─── 6. Create music directory ───────────────────────────────────
MUSIC_DIR="$HOME/Music/MusicBox"
mkdir -p "$MUSIC_DIR"
log "Directorio de música: $MUSIC_DIR"

# ─── 7. Setup MusicBox ───────────────────────────────────────────
MUSICBOX_DIR="$HOME/musicbox"

if [ -f "$MUSICBOX_DIR/server.js" ]; then
  log "MusicBox ya existe en $MUSICBOX_DIR"
else
  log "⚠️  Necesitas subir los archivos de MusicBox a $MUSICBOX_DIR"
  log "   Desde tu PC ejecuta:"
  echo ""
  echo -e "  ${CYAN}scp -i TU_CLAVE.key package.json server.js ubuntu@TU_IP:~/musicbox/${NC}"
  echo -e "  ${CYAN}scp -r -i TU_CLAVE.key public ubuntu@TU_IP:~/musicbox/${NC}"
  echo ""
fi

# ─── 8. Install Node.js dependencies ─────────────────────────────
if [ -f "$MUSICBOX_DIR/package.json" ]; then
  log "Instalando dependencias de Node.js..."
  cd "$MUSICBOX_DIR"
  npm install
fi

# ─── 9. Install and configure PM2 ────────────────────────────────
if command -v pm2 &> /dev/null; then
  log "PM2 ya instalado"
else
  log "Instalando PM2 (gestor de procesos)..."
  sudo npm install -g pm2
fi

# Start MusicBox with PM2 if server.js exists
if [ -f "$MUSICBOX_DIR/server.js" ]; then
  cd "$MUSICBOX_DIR"
  pm2 delete musicbox 2>/dev/null || true
  pm2 start server.js --name musicbox
  pm2 save

  # Configure PM2 to start on boot
  sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u $USER --hp $HOME 2>/dev/null || true
  pm2 save
  log "MusicBox arrancado con PM2 (auto-restart)"
fi

# ─── 10. Configure firewall ──────────────────────────────────────
log "Configurando firewall..."
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3000 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 8096 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || sudo iptables-save | sudo tee /etc/iptables/rules.v4 > /dev/null 2>&1 || true

# ─── 11. Get public IP ───────────────────────────────────────────
PUBLIC_IP=$(curl -s ifconfig.me || echo "NO_DISPONIBLE")

# ─── Done! ────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}"
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║                                              ║"
echo "  ║   ✅  ¡Instalación completada!               ║"
echo "  ║                                              ║"
echo "  ╠══════════════════════════════════════════════╣"
echo "  ║                                              ║"
echo "  ║   🎵 MusicBox:                               ║"
echo -e "  ║   ${CYAN}http://$PUBLIC_IP:3000${GREEN}  ║"
echo "  ║                                              ║"
echo "  ║   📺 Jellyfin:                               ║"
echo -e "  ║   ${CYAN}http://$PUBLIC_IP:8096${GREEN}  ║"
echo "  ║                                              ║"
echo "  ║   📁 Música: ~/Music/MusicBox                ║"
echo "  ║                                              ║"
echo "  ╚══════════════════════════════════════════════╝"
echo -e "${NC}"
echo ""
echo "  Comandos útiles:"
echo "    pm2 status          — Ver estado de MusicBox"
echo "    pm2 logs musicbox   — Ver logs en tiempo real"
echo "    pm2 restart musicbox — Reiniciar MusicBox"
echo "    yt-dlp -U            — Actualizar yt-dlp"
echo ""
