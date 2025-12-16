const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

function hash(password) {
  const salt = bcrypt.genSaltSync(10);
  return bcrypt.hashSync(password, salt);
}

function check(password, passwordHash) {
  return bcrypt.compareSync(password, passwordHash);
}

function sign(user) {
  const payload = {
    id: user.id,
    role: user.role,
    email: user.email,
    name: user.name,
    lang: user.lang || 'en'
  };

  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: '7d'
  });
}

function verify(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return null;
  }
}

module.exports = {
  hash,
  check,
  sign,
  verify
};