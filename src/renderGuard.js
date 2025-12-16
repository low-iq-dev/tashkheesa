// src/renderGuard.js
const fs = require('fs');
const path = require('path');
const viewRegistry = require('./views/registry');

function assertRenderableView(viewName) {
  if (!viewRegistry[viewName]) {
    throw new Error(`🚫 View "${viewName}" is not registered in views/registry.js`);
  }

  const viewPath = path.join(__dirname, 'views', `${viewName}.ejs`);
  if (!fs.existsSync(viewPath)) {
    throw new Error(`🚫 View file missing on disk: ${viewName}.ejs`);
  }
}

module.exports = { assertRenderableView };