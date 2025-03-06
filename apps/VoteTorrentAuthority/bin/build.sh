#!/bin/bash
#Build android and/or IOS release images
#Copyright VoteTorrent.org; See license in root of this package
# -----------------------------------------------------------------------------
target=all
path_a="android/app/build/outputs/apk/release/app-release.apk"
path_i=""
orgdir=$(pwd)
mydir="$(dirname $BASH_SOURCE)"		#Where this script is

build_ios() {
  echo "IOS build not yet implemented"
}

path_ios() {
  echo "IOS path yet implemented"
}

deploy_ios() {
  echo "IOS deploy yet implemented"
}

build_android() {
  cd $mydir/../android 
  if ./gradlew assembleRelease; then
    built_a=true
  else
    built_a=false
  fi
  cd $orgdir			#;echo "RES:$build_a"
}

path_android() {
  if $built_a; then
    echo "Path to APK:${path_a}"
  fi
}

deploy_android() {
  if $built_a && [ ! -z "$VOTETORRENT_AUTHORITY_ANDROID_APK_DEPLOY" ]; then
    echo "Deploying Android APK:${path_a} to $VOTETORRENT_AUTHORITY_ANDROID_APK_DEPLOY"
    scp ${mydir}/../${path_a} $VOTETORRENT_AUTHORITY_ANDROID_APK_DEPLOY
  fi
}

if [ "$1" = "all" ]; then
  build_ios;	path_ios;	deploy_ios
  build_android;	path_android;	deploy_android

elif [ "$1" = "ios" ]; then
  build_ios;  path_ios; deploy_ios

else
  build_android;	path_android;	deploy_android
fi