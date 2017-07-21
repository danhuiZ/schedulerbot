
function refreshTokenIfStale(user) {
  if(/* user token is fresh */){
    return Promise.resolve(user);
  } else {
    return /* Google refresh token */
    .then(function(){
      return user.save()
    })
  }
}
