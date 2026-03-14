const derby = require("../adapters/derby");

class CouncilRouter {
  constructor() {
    this.adapters = { derby };
  }

  getAdapter(councilId) {
    return this.adapters[councilId || "derby"] || derby;
  }
}

module.exports = CouncilRouter;
