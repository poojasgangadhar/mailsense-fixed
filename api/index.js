try {
  module.exports = require('../backend/server.js');
} catch(e) {
  module.exports = (req, res) => {
    res.status(500).json({ 
      error: 'Startup crash', 
      message: e.message, 
      stack: e.stack 
    });
  };
}