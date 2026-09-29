const express = require("express");
const cors = require("cors");
require("dotenv").config();

const router = require("./routes/api.js");
const bodyParser = require("body-parser");

const connectToDatabase = require("./config/database.js");

const app = express();

// CORS
app.use(cors({
    origin: "http://localhost:3000",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

// Body parser
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.get("/", (req, res) => {
    console.log("triggered====> :)");
    res.send("Hello from Node.js!");
});

// API
app.use("/api", router);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});