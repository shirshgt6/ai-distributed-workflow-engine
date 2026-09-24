/**
 * @param {ReturnType<import('../services/execution.service.js').createExecutionService>} executionService
 */
export function createExecutionController(executionService) {
  return {
    async run(req, res) {
      const execution = await executionService.run(req.user, req.valid.params.id, req.valid.body.input);
      // 202 Accepted, not 201/200: the run has STARTED, not finished. The
      // client polls the Location URL for progress.
      res.status(202).location(`/executions/${execution._id}`).json({ execution });
    },

    async get(req, res) {
      const { execution, tasks } = await executionService.get(req.user, req.valid.params.id);
      res.status(200).json({ execution, tasks });
    },
  };
}
