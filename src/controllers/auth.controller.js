/**
 * Controllers only translate HTTP <-> service calls. No business rules here:
 * those live in the service, which can then be reused (scripts, workers)
 * and tested without HTTP.
 *
 * @param {ReturnType<import('../services/auth.service.js').createAuthService>} authService
 */
export function createAuthController(authService) {
  return {
    async register(req, res) {
      const user = await authService.register(req.valid.body);
      res.status(201).json({ user });
    },

    async login(req, res) {
      const { user, ...tokens } = await authService.login(req.valid.body);
      req.log.info({ userId: String(user._id) }, "user logged in");
      res.status(200).json({ user, ...tokens });
    },

    async refresh(req, res) {
      const tokens = await authService.refresh(req.valid.body.refreshToken);
      res.status(200).json(tokens);
    },

    async logout(req, res) {
      await authService.logoutAll(req.user.id);
      // 204: success, nothing to return.
      res.status(204).end();
    },

    async me(req, res) {
      const user = await authService.getUser(req.user.id);
      res.status(200).json({ user });
    },

    async changeRole(req, res) {
      const user = await authService.changeRole({
        actorId: req.user.id,
        targetId: req.valid.params.id,
        role: req.valid.body.role,
      });
      req.log.info({ targetUserId: String(user._id), role: user.role }, "user role changed");
      res.status(200).json({ user });
    },
  };
}
