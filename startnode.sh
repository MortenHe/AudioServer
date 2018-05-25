#!/bin/bash
cd /home/pi/mh_prog/WebSocketAudioMplayerServer
/usr/bin/sudo /usr/bin/node ./server.js > /home/pi/mh_prog/output-server.txt &
/bin/sleep 5
cd /home/pi/mh_prog/WebSocketGPIO
/usr/bin/sudo /usr/bin/node ./button.js > /home/pi/mh_prog/output-button.txt &