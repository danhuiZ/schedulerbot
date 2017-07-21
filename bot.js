'use strict';
var app = require('./app');

// CONNECTING TO MONGO_DB
var mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_URI);
var { User } = require('./models');
var { RtmClient, WebClient, CLIENT_EVENTS, RTM_EVENTS } = require('@slack/client');
var axios = require('axios');

function imReply(data) {
  return ({"attachments": [
    {
      "text": `Creating a reminder for '${data.result.parameters.subject}' on ${data.result.parameters.date}`,
      "fallback": "You are unable to create reminder",
      "callback_id": "reminder",
      "color": "#3AA3E3",
      "attachment_type": "default",
      "actions": [
        {
          "name": "confrim",
          "text": "Yes",
          "type": "button",
          "value": "yes"
        },
        {
          "name": "confirm",
          "text": "Cancel",
          "type": "button",
          "value": "cancel"
        },
      ]
    }
  ]})
}

var token = process.env.SLACK_SECRET || '';
var web = new WebClient(token);
var rtm = new RtmClient(token);
rtm.start();

rtm.on(CLIENT_EVENTS.RTM.AUTHENTICATED, (rtmStartData) => {
  console.log(`logged in as ${rtmStartData.self.name} of team ${rtmStartData.team.name}, but not yet connected to a channel`);
})

rtm.on(RTM_EVENTS.MESSAGE, function handleRtmMessage(message) {
  var dm = rtm.dataStore.getDMByUserId(message.user);
  console.log("DM--------", dm, "MESSAGE-------", message);
  if (!dm || dm.id !== message.channel || message.type !== 'message') {
    console.log('Message not send to DM, ignoring');
    return;
  }
  //CHECK IF THEY ARE IN MONGO AS HAVING REGISTERED GOOGLE
  var u = rtm.dataStore.getUserById(message.user);
  //CHECK FOR USER OR CREATE ONE
  User.findOne({slack_ID: message.user})
  .then(function(user){
    //SET UP INITIAL SLACK INFO IN MONGO
    if(!user){
      return new User({
        slack_ID: message.user,
        slack_DM_ID: message.channel,
        slack_Username: u.profile.real_name,
        slack_Email: u.profile.email,
      }).save();
    }
    return user;
  })
  .then(function(user){
    console.log("USER IS", user);
    if(!user.googleAccount){
      //submit the link to grant Google access
      rtm.sendMessage("Hello This is Scheduler bot. In order to schedule reminders for you, I need access to you Google calendar", message.channel);
      web.chat.postMessage(message.channel,
        'Use this link to give access to your google cal account http://localhost:3000/connect?auth_id='
        + user._id);
        return;
      }

      axios.get('https://api.api.ai/api/query', {
        params: {
          v: 20150910,
          lang: 'en',
          query: message.text,
          sessionId: message.user
        },
        headers: {
          Authorization: `Bearer ${process.env.API_AI_TOKEN}`
        }
      })
      .then(function( { data } ) {
        console.log("DATA", data, "DATA-messages", data.result.fulfillment.messages);

        if(!data.result.actionIncomplete && data.result.parameters.date && data.result.parameters.subject ) {
          // rtm.sendMessage(data.result.fulfillment.speech, message.channel);
          user.pendingState.date = data.result.parameters.date;
          user.pendingState.subject = data.result.parameters.subject;
          user.save()
          .then(function(){
            web.chat.postMessage(message.channel, 'Chill homie', imReply(data), function(err, res) {
              if (err) {
                console.log('Error:', err);
              } else {
                console.log('Message sent: ', res);
              }
            });
          })

        } else if(data.result.parameters.date && !data.result.parameters.subject){
          console.log('NO SUBJECT');
          user.pendingState.date = data.result.parameters.date;
          user.save()
          .then(function() {
            rtm.sendMessage(data.result.fulfillment.speech, message.channel);
          })

        } else if(data.result.parameters.subject && !data.result.parameters.date){
          console.log('NO DATE');
          user.pendingState.subject = data.result.parameters.subject;
          user.save()
          .then(function() {
            rtm.sendMessage(data.result.fulfillment.speech, message.channel);
          })

        } else {
          rtm.sendMessage(data.result.fulfillment.speech, message.channel);
        }
        return;
      })
      .catch(function(err) {
        console.log("ERROR", err);
      })

    });
  });

  rtm.on(RTM_EVENTS.REACTION_ADDED, function handleRtmReactionAdded(reaction) {
    console.log('Reaction added:', reaction);
  });

  rtm.on(RTM_EVENTS.REACTION_REMOVED, function handleRtmReactionRemoved(reaction) {
    console.log('Reaction removed:', reaction);
  });


module.exports = {
  rtm, web
};
