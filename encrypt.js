const forge = require("node-forge");
const https = require("https");

const API_KEY = (process.env.CIRCLE_API_KEY || "").trim();
const ENTITY_SECRET = (process.env.CIRCLE_ENTITY_SECRET || "").trim();

if (!API_KEY || !ENTITY_SECRET) {
  console.error("Set CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET before running encrypt.js.");
  process.exit(1);
}

const options = {
  hostname: "api.circle.com",
  path: "/v1/w3s/config/entity/publicKey",
  method: "GET",
  headers: {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json"
  }
};

https.get(options, (res) => {
  let data = "";
  res.on("data", chunk => data += chunk);
  res.on("end", () => {
    const publicKeyPem = JSON.parse(data).data.publicKey;
    const entitySecret = forge.util.hexToBytes(ENTITY_SECRET);
    const publicKey = forge.pki.publicKeyFromPem(publicKeyPem);
    const encryptedData = publicKey.encrypt(entitySecret, "RSA-OAEP", {
      md: forge.md.sha256.create(),
      mgf1: { md: forge.md.sha256.create() },
    });
    console.log(forge.util.encode64(encryptedData));
  });
});
