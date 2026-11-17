// One-time fix: refreshtokens collection se purane design ke indexes hatana.
//
// Purana design: ek user + device_type ka ek hi refresh token (UNIQUE userId_1_device_type_1).
// Naya design (app/models/RefreshToken.js): har login pe naya token, purane revoked history mein rehte hain.
// Purana UNIQUE index reh gaya toh usi device type se doosra login 500 deta hai:
//   E11000 duplicate key ... index: userId_1_device_type_1
// Mongoose purane indexes khud nahi hatata, isliye ye script.
//
// Chalana: node scripts/dropStaleRefreshTokenIndexes.js   (backend folder se, .env ka MONGODB_URI)
// Data delete nahi hota, sirf index. Dobara chalana safe hai.
require("dotenv").config();
const mongoose = require("mongoose");

const STALE_INDEXES = ["userId_1_device_type_1", "previousTokenHash_1"];

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const collection = mongoose.connection.db.collection("refreshtokens");
    const existing = (await collection.indexes()).map((i) => i.name);

    for (const name of STALE_INDEXES) {
        if (!existing.includes(name)) {
            console.log(`skip   ${name} (not present)`);
            continue;
        }
        await collection.dropIndex(name);
        console.log(`dropped ${name}`);
    }

    console.log("indexes now:", (await collection.indexes()).map((i) => i.name).join(", "));
    await mongoose.disconnect();
})().catch(async (e) => {
    console.error("Failed:", e.message);
    await mongoose.disconnect();
    process.exit(1);
});
