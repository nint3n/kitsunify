const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const JWT_SECRET = process.env.JWT_SECRET || 'kitsunify-hyper-secure-secret-key-2026-xyz!';
const USERS_FILE = path.join(__dirname, 'users.json');

// In-memory failed attempts tracker for brute force protection: ip -> { count, lockedUntil }
const loginAttempts = new Map();

/**
 * Initialize or load users
 */
function getUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    const adminPass = process.env.ADMIN_PASSWORD || 'kitsuneAdmin2026!';
    const userPass = process.env.USER_PASSWORD || 'musica2026';

    const defaultUsers = {
      admin: {
        username: 'admin',
        passwordHash: bcrypt.hashSync(adminPass, 10),
        role: 'admin',
        createdAt: new Date().toISOString()
      },
      invitado: {
        username: 'invitado',
        passwordHash: bcrypt.hashSync(userPass, 10),
        role: 'listener',
        createdAt: new Date().toISOString()
      }
    };

    fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2));
    return defaultUsers;
  }

  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

/**
 * Check if an IP is currently rate-limited
 */
function isIpLocked(ip) {
  const record = loginAttempts.get(ip);
  if (!record) return false;

  if (record.lockedUntil && Date.now() < record.lockedUntil) {
    const minutesLeft = Math.ceil((record.lockedUntil - Date.now()) / 60000);
    return `IP bloqueada temporalmente por intentos fallidos. Reintenta en ${minutesLeft} minutos.`;
  }

  // Lock expired
  if (record.lockedUntil && Date.now() >= record.lockedUntil) {
    loginAttempts.delete(ip);
    return false;
  }

  return false;
}

function recordFailedAttempt(ip) {
  const record = loginAttempts.get(ip) || { count: 0, lockedUntil: null };
  record.count += 1;

  if (record.count >= 5) {
    record.lockedUntil = Date.now() + (15 * 60 * 1000); // 15 mins
    console.warn(`🚨 [SEGURIDAD] IP ${ip} bloqueada por 15 minutos (5 intentos fallidos)`);
  }

  loginAttempts.set(ip, record);
}

function clearFailedAttempts(ip) {
  loginAttempts.delete(ip);
}

/**
 * Authenticate username and password
 */
function authenticateUser(username, password, ip) {
  const lockedMsg = isIpLocked(ip);
  if (lockedMsg) {
    return { error: lockedMsg, status: 429 };
  }

  const users = getUsers();
  const user = users[username.toLowerCase().trim()];

  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    recordFailedAttempt(ip);
    return { error: 'Usuario o contraseña incorrectos', status: 401 };
  }

  clearFailedAttempts(ip);

  // Generate JWT (valid for 30 days)
  const token = jwt.sign(
    {
      username: user.username,
      role: user.role
    },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  return {
    token,
    user: {
      username: user.username,
      role: user.role
    }
  };
}

/**
 * Express middleware to verify JWT
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.startsWith('Bearer '))
    ? authHeader.split(' ')[1]
    : req.query.token; // allow token in query for audio streams

  if (!token) {
    return res.status(401).json({ error: 'Acceso no autorizado: inicia sesión' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Sesión expirada o token inválido' });
  }
}

/**
 * Express middleware to verify Admin role
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Permiso denegado: se requieren privilegios de Administrador' });
  }
  next();
}

/**
 * Change password
 */
function changePassword(username, oldPassword, newPassword) {
  const users = getUsers();
  const user = users[username.toLowerCase()];
  if (!user) return { error: 'Usuario no encontrado' };

  if (!bcrypt.compareSync(oldPassword, user.passwordHash)) {
    return { error: 'La contraseña actual no es correcta' };
  }

  if (!newPassword || newPassword.length < 6) {
    return { error: 'La nueva contraseña debe tener al menos 6 caracteres' };
  }

  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  saveUsers(users);
  return { success: true };
}

module.exports = {
  getUsers,
  authenticateUser,
  requireAuth,
  requireAdmin,
  changePassword
};
