# garagepi
Golang webservice to trigger a relay via Raspberry Pi GPIO to activate a wall mounted garage door opener.

Inspired to create this when I realized my Marantec garage door opener was not compatible with the myQ
smart-garage hub. I then deployed it on a Raspberry Pi running Homebridge and modified the Homebridge
myQ plugin to call this service rather than the myQ API when a request to open or close the Marantec
garage is received.

#Test Pi Powercycle doesn't trigger an unintended opening. Also check first run after reboot.

Relay 1 is on BCM Pin 17, blue and red wires

Build for 32 bit: env GOOS=linux GOARCH=arm GOARM=7 go build
Build for 64 bit: env GOOS=linux GOARCH=arm64 go build
Build with debug symbols: env GOOS=linux GOARCH=arm64 go build -gcflags=all=-N -l -o garagepi_debug

Note - delve debugger only works on arm64 so need it to do interactive debugging. See tasks.json and config.json
for list of tasks to build debug executable, copy to the Pi and start delve for remote debugging. The Homebridge
image from the Raspberry Pi imager is 32bit so need a seperate Pi to develop and test on

The modified Homebridge MyQ plugin code file is myq-api.js, function 'execute'. It lives in 
/var/lib/homebridge/node_modules/homebridge-myq/node_modules/@hjdhjd/myq/dist
