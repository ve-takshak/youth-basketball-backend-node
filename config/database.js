const mongoose = require('mongoose');

mongoose.connect('mongodb://localhost:27017/basketball');

mongoose.connection.once('open', function () {
  console.log("database connected")
}).on('error', function (error) {
  console.log("error:" + error)
})


module.exports = mongoose;