#!/bin/bash
#Server-Script liegt im gleichen Verzeichnis wie sh-Script
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
/usr/bin/sudo /usr/bin/node "${DIR}/server.js" > "${DIR}/../output-server.txt" &