const { db } = require('./db');
const { major: logMajor } = require('./logger');

function tableExists(name) {
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name);
    return !!row;
  } catch (err) {
    logMajor(`tableExists check failed for ${name}: ${err.message}`);
    return false;
  }
}

function safeAll(sql, params = [], fallback = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch (err) {
    logMajor(`SQL safeAll failed: ${err.message}`);
    return fallback;
  }
}

function safeGet(sql, params = [], fallback = null) {
  try {
    return db.prepare(sql).get(...params);
  } catch (err) {
    logMajor(`SQL safeGet failed: ${err.message}`);
    return fallback;
  }
}

module.exports = {
  tableExists,
  safeAll,
  safeGet
};
