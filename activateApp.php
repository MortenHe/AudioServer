<?php

//Welcher Modus soll gestartet werden
$mode = filter_input(INPUT_GET, 'mode');

//Bisherigen Prozess stoppen (Node und mplayer)
exec('sudo /home/pi/mh_prog/AudioServer/stopnode.sh');

//passenden Modus starten
switch ($mode) {
case "audio":
    exec('sudo /home/pi/mh_prog/AudioServer/startnode.sh');
    break;

case "sh":
    exec('sudo /home/pi/mh_prog/NewSHAudioServer/startnodesh.sh');
    break;
}
?>