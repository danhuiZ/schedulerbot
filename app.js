'use strict';
var express = require('express');
var google = require('googleapis');
var OAuth2 = google.auth.OAuth2;
var { User, Reminder } = require('./models');
var axios = require('axios');

// REQUIRED SOURCE CHECKS
var REQUIRED_ENV = "SLACK_SECRET MONGODB_URI GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET DOMAIN".split(" ");
REQUIRED_ENV.forEach(function(el) {
  if (!process.env[el]){
    console.error("Missing required env var " + el);
    process.exit(1);
  }
});

// RUNNING SERVER
var app = express();
var bodyParser = require('body-parser');
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

/* BOT CODE */
var { rtm, web } = require('./bot');

function getGoogleAuth() {
  return new OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.DOMAIN + '/connect/callback'    //redirect url
  );
}

app.get('/connect', function(req, res){
  var userId = req.query.auth_id;
  if (!userId) {
    res.status(400).send("Missing user id");
  } else {
    User.findById(userId)
    .then(function(user){
      if (!user) {
        res.status(404).send("Cannot find user");
      } else {
        var googleAuth = getGoogleAuth();
        var url = googleAuth.generateAuthUrl({
          access_type: 'offline',     //'online' (default) or 'offline' (gets refresh_token)
          prompt: 'consent',
          scope: [
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/calendar',
            'email'
          ],    // generate a url that asks permissions for Google+ and Google Calendar scopes
          state: userId
        });
        res.redirect(url);
      }
    })
  }
})

var plus = google.plus('v1');
var peopleGet = bluebird.promisify(plus.people.get.bind(plus.people))

app.get('/connect/callback', function(req, res){
  var googleAuth = getGoogleAuth();
  var getToken = bluebird.promisify(googleAuth.getToken.bind(googleAuth));
  var tokens;
  var googleUser;
  getToken(req.query.code)
  .then(function(t) {
    console.log("HERE ARE THE TOKENS", t);    // Now tokens contains an access_token and an optional refresh_token. Save them.
    tokens = t;
    googleAuth.setCredentials(tokens);
    return peopleGet({auth: googleAuth, userId: 'me'});
  })
  .then(function(g) {
    googleUser = g;
    return User.findById(req.query.state);
  })
  .then(function(mongoUser) {
    mongoUser.googleAccount = tokens;
    mongoUser.googleAccount.profile_ID = googleUser.id;
    mongoUser.googleAccount.profile_name = googleUser.displayName;
    return mongoUser.save();
  })
  .then(function(mongoUser){
    res.send('You are connected to Google Calendar');    //To /connect/callback webpage
    rtm.sendMessage('You are connected to Google Calendar. Now set your first reminder by talking to me!', mongoUser.slack_DM_ID)    //To slack channel
  })
  .catch(function(err){
    res.status(500).json({error: err});
  })
})

      // plus.people.get({auth: googleAuth, userId: 'me'}, function(err, googleUser) {
      //   console.log("GOOGLEUSER! ME!", googleUser);
      //   if (err) {
      //     res.status(500).json({error: err});
      //   } else {
      //     User.findById(req.query.state)
      //     .then(function(mongoUser){
      //       mongoUser.googleAccount = tokens;
      //       mongoUser.googleAccount.profile_ID = googleUser.id;
      //       mongoUser.googleAccount.profile_name = googleUser.displayName;
      //       return mongoUser.save();
      //     })
      //     .then(function(mongoUser){
      //       res.send('You are connected to Google Calendar');    //To /connect/callback webpage
      //       rtm.sendMessage('You are connected to Google Calendar. Now set your first reminder by talking to me!', mongoUser.slack_DM_ID)    //To slack channel
      //     })
      //   }
      // })




var bluebird = require('bluebird')
var moment = require('moment');
const calendar = google.calendar('v3')
const eventInsert = bluebird.promisify(calendar.events.insert.bind(calendar.events))

app.post('/bot-test', function(req, res){
  var payload = JSON.parse(req.body.payload);
  console.log("PAYLOAD", payload);
  if(payload.actions[0].value === 'yes') {
    // CONNECT TO API.AI NOW THAT YOU HAVE SET UP GOOGLE SHIT
    var curTime = Date.now();
    console.log("CURRENT TIME " + curTime);
    //FIND MONGODB ENTRY TO GET TOKENS AND EXPIRY DATE (maybe this goes in a route too)
    User.findOne( {slack_ID: payload.user.id} )
    .then(function(user){
      console.log("HERE HERE HERE HERE USER IS HERE", user);
      //if token is expired
      if(curTime > user.googleAccount.expiry_date){
        console.log("access_token has expired");
        var googleAuth = getGoogleAuth();
        googleAuth.setCredentials(user.googleAccount);
        return googleAuth.refreshAccessToken(function(err, tokens) {
           console.log("enters this function first...", tokens);
           user.googleAccount = Object.assign({}, user.googleAccount, tokens);
           return user.save(function() {
             return user;
           })
        })
      } else {
      //access_token is still good
        console.log('token still good homie');
        return user;
      }
    })
    .then(function(user){
      //POST MESSAGE TO GOOGLE CALENDAR
      console.log("final console", user);
      console.log("CHECK PENDING STATE", user.pendingState);
      var googleAuth = getGoogleAuth();
      var credentials = Object.assign({}, user.googleAccount);
      delete credentials.profile_ID;
      delete credentials.profile_name;
      googleAuth.setCredentials(credentials);
      var calendar = google.calendar('v3');
      calendar.events.insert( )
      //create calendar event here
      var new_event = {
         "end": {
          "date": user.pendingState.date
         },
         "start": {
          "date": user.pendingState.date
         },
         "description": "you are a gawd",
         "summary": user.pendingState.subject
      }

      axios.post(`https://www.googleapis.com/calendar/v3/calendars/primary/events?access_token=${user.googleAccount.access_token}`, new_event)
      .then(function(response){
        console.log('SUCCESSFULLY POSTED TO CALENDAR');
        console.log('THIS IS THE INFORMATION THE USER HAS', user);
        console.log('this is the state', user.pendingState);
        var reminder = new Reminder({
          subject: user.pendingState.subject,
          day: user.pendingState.date,
          googCalID: user.googleAccount.profile_ID,
          reqID: user.slack_ID
        })
        console.log('this is the REMINDER', reminder);
        reminder.save(function(err) {
          if(err) {
            console.log("Error saving reminder, I cry", err);
          }
        });
        //reset pendingState
        pendingState = {
          date: '',
          subject: ''
        }
      })
      .catch(function(err){
          console.log(err);
      })

    })
  } else {
    res.send('Cancelled :x: :pray: :100: :fire:');
  }
})


var port = process.env.PORT || 3000;
app.listen(port);
console.log('Express started. Listening on port %s', port);


module.exports = {
  app, rtm
};
