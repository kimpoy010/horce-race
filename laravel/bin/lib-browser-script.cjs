'use strict';
/*
 * Loads one of the browser scripts of public/js (written as UMD modules) into Node. (laravel/package.json says "type": "module", so a plain require() of
 * those files does not work; the scripts are classic scripts, not ES modules.)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

module.exports = function load(file, globals) {
  const code = fs.readFileSync(path.isAbsolute(file) ? file : path.join(__dirname, '..', file), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(code, Object.assign({ module, exports: module.exports, console }, globals || {}), { filename: file });
  return module.exports;
};
