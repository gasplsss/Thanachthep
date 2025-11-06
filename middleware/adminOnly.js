module.exports = function adminOnly(req, res, next) {
  if (req.user && req.user.role_id === 1) {
    return next();
  }
  return res.status(403).json({ message: 'Forbidden: admin only' });
};
