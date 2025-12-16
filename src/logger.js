const MODE = (process.env.MODE || 'development').trim().toLowerCase();

const verbose = MODE === 'development'
  ? (...args) => console.log(`[${MODE}]`, ...args)
  : () => {};

const major = MODE === 'production'
  ? () => {}
  : (...args) => console.log(`[${MODE}]`, ...args);

const fatal = (...args) => console.error(`[${MODE}]`, ...args);

module.exports = {
  MODE,
  verbose,
  major,
  fatal
};
