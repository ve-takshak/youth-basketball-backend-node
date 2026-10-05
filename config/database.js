const mongoose = require("mongoose");

const MONGO_URL = process.env.MONGODB_URL

mongoose
    .connect(MONGO_URL)
    .then(() => {
        console.log("Database connected");
    })
    .catch((error) => {
        console.error("MongoDB connection error:", error);
    });

module.exports = mongoose;