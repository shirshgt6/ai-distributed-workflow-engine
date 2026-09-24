/**
 * @param {ReturnType<import('../services/workflow.service.js').createWorkflowService>} workflowService
 */
export function createWorkflowController(workflowService) {
  return {
    async create(req, res) {
      const workflow = await workflowService.create(req.user, req.valid.body);
      // 201 + Location: where the new resource lives.
      res.status(201).location(`/workflows/${workflow._id}`).json({ workflow });
    },

    async list(req, res) {
      const result = await workflowService.list(req.user, req.valid.query);
      res.status(200).json(result);
    },

    async get(req, res) {
      const workflow = await workflowService.get(req.user, req.valid.params.id);
      res.status(200).json({ workflow });
    },

    async update(req, res) {
      const workflow = await workflowService.update(req.user, req.valid.params.id, req.valid.body);
      res.status(200).json({ workflow });
    },
  };
}
