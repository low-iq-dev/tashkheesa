const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { verify } = require('./auth');
const { t: translate } = require('./i18n');
const dayjs = require('dayjs');
require('dotenv').config();

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || 'tashkheesa_portal';

function baseMiddlewares(app) {
  app.use(helmet());
  app.use(cookieParser());
  app.use(require('express').urlencoded({ extended: true }));
  app.use(require('express').json());

  // Rate limiter
  const limiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 100
  });
  app.use(limiter);

  // Attach user + language to locals
  app.use((req, res, next) => {
    const token = req.cookies[SESSION_COOKIE];
    let user = null;

    if (token) user = verify(token);
    req.user = user || null;

    const lang = req.cookies.lang === 'ar' ? 'ar' : 'en';
    res.locals.lang = lang;
    res.locals.dir = lang === 'ar' ? 'rtl' : 'ltr';
    res.locals.user = user;
    res.locals.brand = process.env.BRAND_NAME || 'Tashkheesa';
    res.locals.formatEventDate = (iso) => {
      if (!iso) return '';
      const d = dayjs(iso);
      if (!d.isValid()) return '';
      return d.format('DD/MM/YYYY — hh:mm A');
    };
    res.locals.t = (key) => translate(key, lang);
    next();
  });
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (req.user.role !== role) return res.status(403).send('Forbidden');
    next();
  };
}

module.exports = {
  baseMiddlewares,
  requireRole
};
