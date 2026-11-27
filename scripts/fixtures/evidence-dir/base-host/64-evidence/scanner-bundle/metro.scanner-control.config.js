const base = require('./metro.base.config.js');
base.resolver = base.resolver || {};
base.resolver.blockList = [];
module.exports = base;
