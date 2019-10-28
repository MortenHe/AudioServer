<?php
header('Access-Control-Allow-Origin: *');

//Welcher Modus soll gestartet werden
$mode = filter_input(INPUT_GET, 'mode');

//Bisherigen Prozess stoppen (Node und mplayer)
exec('sudo /home/pi/mh_prog/AudioServer/stopnode.sh');

//passenden Modus starten
switch ($mode) {

//Audio Player
case "audio":
    exec('sudo /home/pi/mh_prog/AudioServer/startnode.sh');
    break;

//SH Audio Player
case "sh":

    //Ggf. schon audioMode uebergeben, der gestartet werden soll
    $audioMode = filter_input(INPUT_GET, 'audioMode');
    $suffix = $audioMode ? " " . $audioMode : "";
    exec('sudo /home/pi/mh_prog/NewSHAudioServer/startnodesh.sh' . $suffix);
    break;

//Sound Quiz
case "soundquiz":
    exec('sudo /home/pi/mh_prog/SoundQuizServer/startnodesound.sh');
    break;
}
?>