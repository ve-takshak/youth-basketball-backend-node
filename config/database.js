const mongoose = require("mongoose");

// Connection string .env ke MONGODB_URI se aata hai. Password code mein nahi rakhna.
mongoose
    .connect(process.env.MONGODB_URI)
    .then(() => console.log("Database connected"))
    .catch((error) => console.error("MongoDB connection error:", error));

module.exports = mongoose;
