// Ek baar chalana hai: purane "admin" aur "owner" users ko "superAdmin" banana.
// Command (backend folder mein): npm run migrate:roles
require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        const result = await mongoose.connection
            .collection("users")
            .updateMany({ role: { $in: ["admin", "owner"] } }, { $set: { role: "superAdmin" } });
        console.log(`Done. ${result.modifiedCount} user(s) changed to superAdmin.`);
    } catch (e) {
        console.error("Migration failed:", e.message);
    } finally {
        await mongoose.disconnect();
    }
})();
