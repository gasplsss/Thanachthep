const jwt = require('jsonwebtoken');

module.exports = function authRequired(req, res, next) {
  try {
    const token = req.cookies?.token;
    if (!token) return res.status(401).json({ message: 'Unauthorized' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, email, role_id, full_name }
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};
