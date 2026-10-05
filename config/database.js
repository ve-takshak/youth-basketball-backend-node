const mongoose = require("mongoose");

const MONGO_URI =
  "mongodb+srv://shubhamchaudhari707_db_user:FZloRdJNxX0eacgm@cluster0.ilnxzqf.mongodb.net/basketball?retryWrites=true&w=majority";

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("Database connected");
  })
  .catch((error) => {
    console.error("MongoDB connection error:", error);
  });

module.exports = mongoose;