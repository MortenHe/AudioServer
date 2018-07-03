#!/bin/bash
cd /home/pi/mh_prog/WebSocketAudioMplayerServer
/usr/bin/sudo /usr/bin/node ./server.js > /home/pi/mh_prog/output-server.txt &
/bin/sleep 5
cd /home/pi/mh_prog/WebSocketGPIO
/usr/bin/sudo /usr/bin/node ./button.js > /home/pi/mh_prog/output-button.txt &
/usr/bin/sudo /usr/bin/node ./led.js > /home/pi/mh_prog/output-led.txt &
/usr/bin/sudo /usr/bin/node ./rotary.js > /home/pi/mh_prog/output-rotary.txt &
/usr/bin/sudo /usr/bin/node ./rfid.js > /home/pi/mh_prog/output-rfid.txt &