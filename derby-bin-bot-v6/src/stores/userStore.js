const fs = require("fs");
const path = require("path");

class UserStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dataFile = path.join(dataDir, "bot-data.json");
    this.ensureStore();
  }

  ensureStore() {
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.dataFile)) {
      fs.writeFileSync(this.dataFile, JSON.stringify({ users: {}, sent: {} }, null, 2));
    }
  }

  load() {
    return JSON.parse(fs.readFileSync(this.dataFile, "utf8"));
  }

  save(store) {
    fs.writeFileSync(this.dataFile, JSON.stringify(store, null, 2));
  }

  getOrCreateUser(store, phone) {
    if (!store.users[phone]) {
      store.users[phone] = {
        phone,
        state: "new",
        paused: false,
        postcode: "",
        addressQuery: "",
        label: "",
        councilId: "derby",
        pendingMatches: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    }
    return store.users[phone];
  }
}

module.exports = UserStore;
