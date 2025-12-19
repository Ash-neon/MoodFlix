try {
  module.exports = require('../../mq/mqClient');
} catch (e) {
  console.warn('[mqClient shim] MQ not available:', e && e.message);
  module.exports = { sendRPC: async () => { throw new Error('MQ unavailable'); } };
}
