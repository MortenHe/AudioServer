#!/bin/bash
#Server-Script liegt im benachbartem Verzeichnis zum sh-Script
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
/usr/bin/sudo /usr/bin/node "${DIR}/../NewSHAudioServer/server.js" ${1:-''} > "${DIR}/../output-server.txt" &