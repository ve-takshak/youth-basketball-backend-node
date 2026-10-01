const mongoose = require('mongoose');

// mongoose.connect('mongodb://localhost:27017/basketball');
mongoose.connect('mongodb+srv://shubhamchaudhari707_db_user:FZloRdJNxX0eacgm@cluster0.ilnxzqf.mongodb.net/?appName=Cluster0');

mongoose.connection.once('open', function () {
  console.log("database connected")
}).on('error', function (error) {
  console.log("error:" + error)
})


module.exports = mongoose;