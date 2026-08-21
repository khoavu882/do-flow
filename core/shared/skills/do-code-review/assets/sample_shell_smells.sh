#!/usr/bin/env bash
# A script with the failure modes shell review exists to catch.

deploy_release() {
  cd $RELEASE_DIR
  rm $STALE_ARTIFACT
  cp $SOURCE $DEST
}

function rollback {
  cd /var/tmp
  cat $LOGFILE
}

deploy_release
