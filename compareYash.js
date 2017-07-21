var express = require('express');
var bodyParser = require('body-parser');
var google = require('googleapis');
var RtmClient = require('@slack/client').RtmClient;
var RTM_EVENTS = require('@slack/client').RTM_EVENTS;
var WebClient = require('@slack/client').WebClient;
var mongoose = require('mongoose');
var models = require('./models');
var axios = require('axios');
var moment = require('moment');
var _ = require('underscore');
moment().format();

var meetings = 0;


var token = process.env.SLACK_SECRET || '';
var web = new WebClient(token);
var rtm = new RtmClient(token);
var app = express();
var plus = google.plus('v1')
rtm.start();

var OAuth2 = google.auth.OAuth2;
mongoose.connect(process.env.MONGODB_URI);

// REQUIRED SOURCE CHECKIES
var REQUIRED_ENV = "SLACK_SECRET MONGODB_URI GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET DOMAIN".split(" ");

REQUIRED_ENV.forEach(function(el) {
  if (!process.env[el]){
    console.error("Missing required env var " + el);
    process.exit(1);
  }
});

// INTERACTIVE BUTTON OBJECT
var obj = {
  "attachments": [
    {
      "text": "Is this ok?",
      "fallback": "",
      "callback_id": "wopr_game",
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
  ]
}

var newObj = {
  "attachments": [
    {
      "text": "Is this ok?",
      "fallback": "",
      "callback_id": "wopr_game",
      "color": "#3AA3E3",
      "attachment_type": "default",
      "actions": [
        {
          "name": "OK wait",
          "text": "Yes",
          "type": "button",
          "value": "wait"
        },
        {
          "name": "confirm",
          "text": "Cancel",
          "type": "button",
          "value": "cancel"
        },
      ]
    }
  ]
}

var dropdown_obj = {
  "attachments": [
       {
           "text": "Scheduled time was not available. Here are some alternatives!",
           "fallback": "WHAT IS A FALLBACK BRO?",
           "color": "#3AA3E3",
           "attachment_type": "default",
           "callback_id": "alt_date_selection",
           "actions": [
               {
                   "name": "alt_dates",
                   "text": "Pick an alternate date and time...",
                   "type": "select",
                   "options": []
               },
               {
                 "name": "confirm",
                 "text": "Cancel",
                 "type": "button",
                 "value": "cancel"
               }
           ]
       }
   ]
}

function getObject(array){

  var tempObj = dropdown_obj;
  for(var i = 0 ;i < array.length; i++ ){
    tempObj.attachments[0].actions[0].options.push({"text":array[i], "value":array[i]})
  }

  console.log('TEMPOBJ HERE ==>>> ', tempObj);
  return tempObj;

}

// checking conflict

var getWeekArray = function(date, time){

  console.log("entered getWeekArray");
  var startString = date + time;
  var a = moment(date);
  var b = a.add(7, 'day'); //make this shit a moment god dammit
  var c = b.format().substring(0,19);
  var endString = c.split('T').join(' ');
  var start = moment(startString, 'YYYY-MM-DD hh:mm a');
  var end = moment(endString, 'YYYY-MM-DD hh:mm a');
  var result = [];
  var current = moment(start);
  while (current <= end) {
        result.push(current.format('YYYY-MM-DD HH:mm'));
        current.add(30, 'minutes');
  }

  console.log("original weekArray", result);

  result = result.filter(function(item){
    var item = item.split(' ');
    var time = parseInt(item[1].substring(0,2));
    return (time>=9 && time<=18);
  })

  return result;

}  //returns week array

var cutWeekArray = function(busyArray, state){

  console.log("entered function cutWeekArray");

  var weekArray = getWeekArray(state.date, state.time);

  console.log("weekArray", weekArray);

  for(var i=0;i<busyArray.length;i+=2){
    var x = weekArray.indexOf(busyArray[i]);
    var y = weekArray.indexOf(busyArray[i+1]);
    if(x!==-1)weekArray.splice(x,y-x);
  }
  console.log("after cutting weekArray", weekArray);
  return weekArray;
} // returns week array with available time slots

var limitWeekArray = function(weekArray){

  console.log("entered limitWeekArray");

  var finalArray = [];

  for(var i = 1; i < 8 ; i++){
    finalArray.push([]);
  }

  console.log("finalArray", finalArray);

  var j = 0 ;

  for(var i=0;i<weekArray.length; i++){
    if(finalArray[j].length===3){
      j++;
      var date = parseInt(weekArray[i].substring(8,10));
      var target = date===30 || date===31 ? 1 : date+1;
      for(var z=0;z<weekArray.length;z++){
        var look = parseInt(weekArray[z].substring(8,10));
        if(target === look){
          i=z;
          break;
        }
      }
      if(j===7)break;
    }
    finalArray[j].push(weekArray[i]);
  }

  console.log("finalArray", finalArray);
  var mainArray = [];
  var k=0;
  while(mainArray.length!==10){
    if(finalArray[k].length===0)k++;
    mainArray.push(finalArray[k].shift());
  }
  console.log("mainArray", mainArray);
  return mainArray;
} // cuts down weekArray to 10 slots;

function findAttendeesHere(state){

  return models.User.find({})
  .then(function(err, users){
    var attendees = [];
    users.forEach(function(item){
      var id = item.slack_ID;
      console.log(item);
      if(state.inviteesBySlackid.indexOf(id) !== -1){
          if(!item.googleAccount.email || !item.googleAccount.access_token){
            attendees.push({"slack_ID": id, "email":"", "access_token":""});
          }else{
            attendees.push({"slack_ID": id, "email": item.googleAccount.email, "access_token": item.googleAccount.access_token});
          }
      }
    })
    console.log('INSIDE FIND ATTENDEES METHOD');
    console.log(attendees);
    return attendees;
  })

}

function pendingFunction(attendees, user){
  var state = user.pendingState;
  meetings++;

  var meeting = new models.Meeting({
    eventId: meetings,
    date: state.date,
    time: state.time,
    invitees: attendees, //this attendess is array of objects with empty email but has slack id
    requesterId: user.slack_ID,
    createdAt: new Date()
  })

  meeting.save();
  attendees.pop();
  attendees.forEach(function(attendee){
    if(attendee.email===''){
      Users.findOne({slack_ID:attendee.slack_ID},function(err,user){
        rtm.sendMessage('Use this link to give access to your google cal account ' + process.env.DOMAIN + '/connect?auth_id='
        + user._id, user.slack_DM_ID))
      });
    }
  })

}

var checkConflict = function(user){
  console.log("entered the funtion checkConflict");
  return findAttendeesHere(user.pendingState)
  .then(attendees => {
      console.log("started forming attendees");
      var calendarPromises = [];
      var attendeeCalendars;
      var busyArray = [];
      var unavailableArray = [];

      attendees.forEach(function(attendee) {
          if(attendee.email===""){
            unavailableArray.push(attendee);
          }
          var email = encodeURIComponent(attendee.email);
          var calendarStart = new Date().toISOString();
          var timeMin = encodeURIComponent(calendarStart);
          var accessToken = encodeURIComponent(attendee.access_token);
          calendarPromises.push(axios.get(`https://www.googleapis.com/calendar/v3/calendars/${email}/events?timeMin=${timeMin}&access_token=${accessToken}`))
      })

      if(unavailableArray.length===0){
        return Promise.all(calendarPromises)
        .then(function(calendars) {

            attendeeCalendars = calendars.map(function(calendar) {
                return calendar.data.items;
            })

            attendeeCalendars.forEach(function(calendar, index){
              attendeeCalendars[index] = calendar.filter(function(item){
                return item.start.dateTime;
              })
            })

            attendeeCalendars.forEach(function(calendar, index){
             attendeeCalendars[index] = calendar.forEach(function(item){
                var start = item.start.dateTime.split('T');
                var end = item.end.dateTime.split('T');
                var startArr = [start[0], start[1].slice(0,5)];
                var endArr = [end[0], end[1].slice(0,5)];
                busyArray.push(startArr.join(' '));
                busyArray.push(endArr.join(' '));
              })
            })

            console.log("busyArray", busyArray);

            var meetingString = user.pendingState.date + ' ' + user.pendingState.time.substring(0,5);

            console.log("checkString", meetingString);

            if(busyArray.indexOf(meetingString)===-1){
              console.log("this is where i want to be");
              return "noConflict"; //  no conflict;
            }

            var flag1 = cutWeekArray(busyArray, user.pendingState);

            console.log("after cutting flag1", flag1);

            flag1 = limitWeekArray(flag1);

            console.log("after limiting weeek array", flag1);

            return flag1;
        })
        .catch(function(err){
          console.log(err)
        });
      }

      else{
        pendingFunction( attendees , user);
        return "People are unavailable";
      }

  })
  .then(function(flag1){
    console.log(flag1);
    return flag1;
  })
  .catch(function(error){
    console.log(error);
  })
} // creates a busy array using everyones data


// TASK FUNCTIONS

var taskHandler = function({result}, message, state){
  if(result.parameters.date && result.parameters.subject){
    state.date = result.parameters.date; state.subject = result.parameters.subject;
    obj.attachments[0].text = `Create task to ${state.subject} on ${state.date}`;
    web.chat.postMessage(message.channel, "Scheduler Bot", obj,function(err, res) {
      if (err) {
        console.log('Error:', err);
      } else {
        console.log('Message sent: ', res);
      }
    });
  } else if(result.parameters.subject){
    state.subject = result.parameters.subject;
    rtm.sendMessage(result.fulfillment.speech, message.channel);
  } else if(result.parameters.date){
    state.date = result.parameters.date;
    rtm.sendMessage(result.fulfillment.speech, message.channel)
  }
}

var taskFunction = function(data, message, state){
  if(!state.date || !state.subject){
    taskHandler(data, message, state);
  } else if(state.date && state.subject){
    rtm.sendMessage("Reply to previous task status", message.channel);
  } else {
    taskHandler(data, message, state);
  }
}

// MEETING FUNCTIONS

var meetingHandler = function({result}, message, user){ //ccccc

  // if all present execute if condition else go to else

  var state = user.pendingState;

  if(result.parameters.date && result.parameters.time && result.parameters.invitees[0]){
    //set state
    state.date = result.parameters.date;
    state.time = result.parameters.time;
    state.invitees = result.parameters.invitees;
    //create invite string
    var inviteString = "";
    state.invitees.forEach(function(item){
      inviteString = inviteString + " and " + item;
    })

    //////

    user.pendingState = state;

    user.save(function(err, user){
      console.log("enter here after setting pendingState");
      var date = new Date();
      var hourNow = date.getHours();
      var meetingHour = parseInt(user.pendingState.time.substring(0,2));

      if(meetingHour - hourNow < 4 ){
        obj.attachments[0].text = `Too soon bro`;
        web.chat.postMessage(message.channel, "Scheduler Bot", newObj,function(err, res) {
          if (err) {
            console.log('Error:', err);
          } else {
            console.log('Message sent: ', res);
          }
        });
      }

      else{

        checkConflict(user).then(flag1=>{
          console.log(flag1);
          if(flag1==='People are unavailable'){
            obj.attachments[0].text = `People are unavailable`;
            web.chat.postMessage(message.channel, "Scheduler Bot", newObj,function(err, res) {
              if (err) {
                console.log('Error:', err);
              } else {
                console.log('Message sent: ', res);
              }
            });
          }
          if(flag1==='noConflict'){
            obj.attachments[0].text = `Schedule meeting with ${inviteString} on ${state.date} ${state.time} about ${state.subject}`;
            web.chat.postMessage(message.channel, "Scheduler Bot", obj,function(err, res) {
              if (err) {
                console.log('Error:', err);
              } else {
                console.log('Message sent: ', res);
              }
            });
          }
          else{
            console.log("entered conflict");
            var targetObj = getObject(flag1);

            web.chat.postMessage(message.channel, "Scheduler Bot", targetObj,function(err, res) {
              if (err) {
                console.log('Error:', err);
              } else {
                console.log('Message sent: ', res);
              }
            });
          }
        });

      }

    })
  }
  else {
    //check for all parameters
    if(result.parameters.subject){
      state.subject = result.parameters.subject;
    }
    if(result.parameters.date){
      state.date = result.parameters.date;
    }
    if(result.parameters.time){
      state.time = result.parameters.time;
    }
    if(result.parameters.invitees[0]){
      state.invitees = result.parameters.invitees;
    }
    user.pendingState = state;
    user.save();
    rtm.sendMessage(result.fulfillment.speech, message.channel);
  }


}

var meetingFunction = function(data, message, user){ //ccccc
  var state = user.pendingState;
  if(!state.date || !state.invitees[0] || !state.time){
    meetingHandler(data, message, user); //cccccc
  } else if(state.date && state.time && state.invitees[0]){
    rtm.sendMessage("Reply to previous task status", message.channel);
  } else {
    meetingHandler(data, message, user); ///cccccc
  }
}

var setInvitees = function(myString, state){
  var myArray = myString.split(' ');
  myArray.forEach(function(item,index){
    if(item[0]==='<'){
      item = item.substring(2,item.length-1);
      state.inviteesBySlackid.push(item);
      myArray[index] = rtm.dataStore.getUserById(item).real_name;
    }
  });
  return myArray.join(' ');
}


rtm.on(RTM_EVENTS.MESSAGE, function handleRtmMessage(message) {

  var dm = rtm.dataStore.getDMByUserId(message.user);

  if (!dm || dm.id !== message.channel || message.type !== 'message') {
    return;
  }

  ////////////////////////////////////////////////ANDREWS FLOW HERE//////////////////////////////

  var u = rtm.dataStore.getUserById(message.user);

  //CHECK FOR USER OR CREATE ONE
  models.User.findOne({slack_ID: message.user})
  .then(function(user){
    //SET UP INITIAL SLACK INFO IN MONGO
    if(!user){
      var user = new models.User({
        default_meeting_len: 30,
        slack_ID: message.user,
        slack_Username: u.profile.real_name,
        slack_Email: u.profile.email,
        slack_DM_ID: message.channel
      })
      return user.save();
    } else{
      return user;
    }
  })
  .then(function(user){
    //AUTHORIZE GOOGLE ACCOUNT LINK
      if(!user.googleAccount.access_token){
        web.chat.postMessage(message.channel,
          'Use this link to give access to your google cal account ' + process.env.DOMAIN + '/connect?auth_id='
          + user._id);
          return;
      }
      else {

          if(message.text.indexOf('schedule')!==-1){
            message.text = setInvitees(message.text , user.pendingState);
            user.pendingState.inviteesBySlackid(user.slack_ID);
            user.save();
          }

          var temp = encodeURIComponent(message.text);

          axios.get(`https://api.api.ai/api/query?v=20150910&query=${temp}&lang=en&sessionId=${message.user}`, {
            "headers": {
              "Authorization":"Bearer 678861ee7c0d455287f791fd46d1b344"
            },
          })
          .then(function({ data }){

            if(message.text.indexOf("schedule")!==-1){
              meetingFunction(data, message, user); //cccccc

            }else{
              taskFunction(data, message, user.pendingState);
              user.save();
            }

          })
          .catch(function(error){
            console.log(error);
          })

      }

    })
  .catch(function(error){
      console.log(error);
  })
})

rtm.on(RTM_EVENTS.REACTION_ADDED, function handleRtmReactionAdded(reaction) {
    console.log('Reaction added:', reaction);
});

rtm.on(RTM_EVENTS.REACTION_REMOVED, function handleRtmReactionRemoved(reaction) {
    console.log('Reaction removed:', reaction);
});


// ROUTES
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

function googleAuth() {
  return new OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.DOMAIN + '/connect/callback'
  );
}

// routes

app.get('/connect', function(req, res){
  var oauth2Client = googleAuth();
  var url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/calendar',
      'email'
    ],
    state: encodeURIComponent(JSON.stringify({
      auth_id: req.query.auth_id
    }))
  });

  res.redirect(url);
})

app.get('/connect/callback', function(req, res){
  var oauth2Client = googleAuth();
  oauth2Client.getToken(req.query.code, function (err, tokens) {
    // Now tokens contains an access_token and an optional refresh_token. Save them.
    oauth2Client.setCredentials(tokens);

    plus.people.get({auth: oauth2Client, userId: 'me'}, function(err, googleUser) {

      //UPDATE GOOGLE CREDENTIALS FOR USER
      var state = JSON.parse(decodeURIComponent(req.query.state))

      models.User.findByIdAndUpdate(state.auth_id, {
        googleAccount: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          profile_ID: googleUser.id,
          expiry_date: tokens.expiry_date,
          profile_name: googleUser.displayName,
          email: googleUser.emails[0].value
        }
      })
      .then(function(user){
        // user.save();
        res.send('SUCCESSFULLY CONNECTED');
      })
      .catch(function(err){
        console.log('ERROR ' + err);
      })
    })

  });

})

function clearState (user){
  user.pendingState = {
    subject: "",
    date: "",
    time: "",
    invitees: [],
    inviteesBySlackid: [],
  };
  user.save(function(err){
    if(err)console.log(err);
  });
}

app.post('/bot-test', function(req,res) {

  var data = JSON.parse(req.body.payload);
  console.log("*************reached here******************", data);

  if(data.actions[0].value==="cancel"){
      models.User.findOne({slack_ID: JSON.parse(req.body.payload).user.id})
      .then(function(user){
        clearState(user)
      })
      res.send("Your request has been cancelled. " + ':pray: :100: :fire:');
  }

  else{
      var curTime = Date.now();
      //console.log("*****STATE****", user.pendingState);
      models.User.findOne({slack_ID: JSON.parse(req.body.payload).user.id})
      .then(function(user){
        console.log("*****STATE****", user.pendingState);
        if(curTime > user.googleAccount.expiry_date){
          console.log("access_token has expired", user);
          var googleAuthV = googleAuth();
          googleAuthV.setCredentials(user.googleAccount);
          return googleAuthV.refreshAccessToken(function(err, tokens) {
            console.log("enters this function first...", tokens);
            user.googleAccount = tokens;
            return user.save(function(err) {
              if(err){
                console.log("blah blah err", err);
              } else {
                console.log("no error");
              }
              return user;
            })
          })
          .then(function(user){
            console.log("this is second console before final console", user);
            return user;
          })
        }
        else{
          console.log('token still good homie');
          return user;
        }
      })
      .then(function(user) {
          var state = user.pendingState;
          //POST TASK OR MEETING TO GOOGLE CAL
          if(state.invitees.length === 0){
            //POST TASK
            taskPath(user, state).then((flag) => {
              if(flag){
                clearState(user);
                res.send("Task has been added to your calendar " + ':pray: :100: :fire:');
              }else{
                clearState(user);
                res.send("Failed to post task to calendar")
              }
            });
          }  //for task
          else{ // for meeting
            //POST MEETING
            if(data.actions[0].name==='alt_dates'){
              console.log("i want this", data.actions[0].selected_options );
              var mo = data.actions[0].selected_options[0];
              var mo1 = mo.value.split(' ');
              user.pendingState.date = mo1[0];
              user.pendingState.time = mo1[1] + ":00";
              user.save(function(err,user){
                meetingPath(user, user.pendingState).then((flag) => {
                  console.log("FLAG", flag);
                  if(flag){
                    clearState(user);
                    res.send("Meeting has been added to your calendar " + ':pray: :100: :fire:');
                  }else{
                    clearState(user);
                    res.send("Failed to post meeting to calendar")
                  }
                });
              });
            } // for meeting with conflicts
            else{
              meetingPath(user, state).then((flag) => {
                console.log("FLAG", flag);
                if(flag){
                  clearState(user);
                  res.send("Meeting has been added to your calendar " + ':pray: :100: :fire:');
                }else{
                  clearState(user);
                  res.send("Failed to post meeting to calendar")
                }
              });
            } //for meeting without conflicts
          }
      })
      .catch(function(error){
        console.log("********error********", error);
      })
    }
})


// FUNCTIONS

function taskPath(user, state){

    if(user){
      //create calendar event here
      var new_event = {
        "end": {
          "date": state.date
        },
        "start": {
          "date": state.date
        },
        "description": "Chief Keef is a fucking legend",
        "summary": state.subject
      }
      return axios.post(`https://www.googleapis.com/calendar/v3/calendars/primary/events?access_token=${user.googleAccount.access_token}`, new_event)
      .then(function(response){

        console.log('RESPONSE', response.status);
        console.log('THIS IS THE INFORMATION THE USER HAS', user);
        console.log('this is the state', state);

        var reminder = new models.Reminder({
          subject: state.subject,
          day: state.date,
          googCalID: user.googleAccount.profile_ID,
          reqID: user.slack_ID
        })

        console.log('this is the REMINDER', reminder);

        reminder.save(function(err) {
          if(err) {
            console.log('there is an error', err);
          } else {
            console.log('saved reminder in mongo');
          }
        });

        console.log(typeof response.status);

        if(response.status === 200){
          console.log('fuck you');
          return true;
        }else{
          console.log('yay');
          return false;
        }


      })
      .then(function(flag){
        console.log("reached here bitch");
        return flag;
      })
      .catch(function(err){
        console.log(err);
      })
    }

}

function findAttendees(state){

  return models.User.find({})
  .then(function(users){
    var attendees = [];

    users.forEach(function(item){
      var id = item.slack_ID;
      console.log(item);
      if(state.inviteesBySlackid.indexOf(id) !== -1){
          attendees.push({"email": item.googleAccount.email, "access_token": item.googleAccount.access_token})
      }
    })
    console.log('INSIDE FIND ATTENDEES METHOD');
    console.log(attendees);
    return attendees;
  })

}

function calculateEndTimeString(state){
    //set up for default 30 minute meetings until api.ai is trained better
    var meetingLength = 60;
    var end =  state.date + 'T' + state.time;
    var endMoment = moment(end);
    endMoment.add(meetingLength, 'minute');
    return endMoment;
}

function calculateStartTimeString(state){
    var start =  state.date + 'T' + state.time;
    var startMoment = moment(start);
    return startMoment;
}

function meetingPath(user, state){

    var start = calculateStartTimeString(state);
    var end = calculateEndTimeString(state);
    var subject = state.subject || 'DEFAULT MEETING SUBJECT';

    if(user){
    return findAttendees(state)
    .then((attendees) => {
      console.log('ATTENDEES ARRAY: ', attendees);
      var new_event = {
        "end": {
          "dateTime": end,
          "timeZone": "America/Los_Angeles"
        },
        "start": {
          "dateTime": start,
          "timeZone": "America/Los_Angeles"
        },
        "summary": subject,
        "attendees": attendees
      //  "description": "ramma lamma ding dong. as always"
      }
      return axios.post(`https://www.googleapis.com/calendar/v3/calendars/primary/events?access_token=${user.googleAccount.access_token}`, new_event)
      .then(function(response){

        console.log('RESPONSE', response.status);
        console.log('THIS IS THE INFORMATION THE USER HAS', user);
        console.log('this is the state', state);

        var reminder = new models.Reminder({
          subject: state.subject,
          day: state.date,
          googCalID: user.googleAccount.profile_ID,
          reqID: user.slack_ID
        })

        console.log('this is the REMINDER', reminder);

        reminder.save(function(err) {
          if(err) {
            console.log('there is an error', err);
          } else {
            console.log('saved reminder in mongo');
          }
        });

        if(response.status === 200){
          return true;
        }else{
          return false;
        }


      })
      .then(function(flag){
        return flag;
      })
      .catch(function(err){
        console.log(err);
      })
    })
    .then(flag=>{
      return flag;
    })
  }

}


app.listen(3000);

module.exports = {
  rtm
}
