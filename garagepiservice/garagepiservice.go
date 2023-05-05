package garagepiservice

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/68wooley/garagepi/appconfig"
	"github.com/stianeikeland/go-rpio"
)

var clientMutex sync.RWMutex

var (
	WarningLogger *log.Logger
	InfoLogger    *log.Logger
	ErrorLogger   *log.Logger
)

type PressResponse struct {
	Result    bool   `json:"RESULT"`
	Button    int    `json:"Button"`
	GPIOPin   int    `json:"GPIOPIN"`
	Duration  int    `json:"DURATION"`
	Timestamp string `json:"TIMESTAMP"`
}

func PressButton1(w http.ResponseWriter, r *http.Request) {

	clientMutex.RLock()
	defer clientMutex.RUnlock()

	w.Header().Set("Content-Type", "application/json")

	rpio.Open()
	defer rpio.Close()

	//Use BCM Pin Numbers - see
	//https://pkg.go.dev/github.com/stianeikeland/go-rpio/v4

	pinNum, err := strconv.Atoi(appconfig.ConfigData.Button1GPIOPin)
	if err != nil {
		pinNum = 20
	}
	pin := rpio.Pin(pinNum)
	//Set the to high or low BEFORE setting to Output mode to avoid
	//accidentally triggering a garage opening before we are ready
	pin.High()
	pin.Output()

	pressDuration, err := strconv.Atoi(appconfig.ConfigData.Button1PressDuration)
	if err != nil {
		pressDuration = 2
	}
	InfoLogger.Printf("Button 1: Toggling on PIN %v for %v seconds", pinNum, pressDuration)
	pin.Low()
	time.Sleep(time.Duration(pressDuration) * time.Second)
	pin.High()

	var cr PressResponse
	cr.Result = true
	cr.Button = 1
	cr.GPIOPin = pinNum
	cr.Duration = pressDuration
	cr.Timestamp = fmt.Sprint(time.Now().Format("01/02/2006 03:04:05PM -0700"))

	json.NewEncoder(w).Encode(cr)
}

func PressButton2(w http.ResponseWriter, r *http.Request) {

	clientMutex.RLock()
	defer clientMutex.RUnlock()

	w.Header().Set("Content-Type", "application/json")

	rpio.Open()
	defer rpio.Close()

	//Use BCM Pin Numbers - see
	//https://pkg.go.dev/github.com/stianeikeland/go-rpio/v4

	pinNum, err := strconv.Atoi(appconfig.ConfigData.Button2GPIOPin)
	if err != nil {
		pinNum = 20
	}
	pin := rpio.Pin(pinNum)
	pin.High()
	pin.Output()

	pressDuration, err := strconv.Atoi(appconfig.ConfigData.Button2PressDuration)
	if err != nil {
		pressDuration = 2
	}
	InfoLogger.Printf("Button 2: Toggling on PIN %v for %v seconds", pinNum, pressDuration)
	pin.Low()
	time.Sleep(time.Duration(pressDuration) * time.Second)
	pin.High()

	var cr PressResponse
	cr.Result = true
	cr.Button = 2
	cr.GPIOPin = pinNum
	cr.Duration = pressDuration
	cr.Timestamp = fmt.Sprint(time.Now().Format("01/02/2006 03:04:05PM -0700"))

	json.NewEncoder(w).Encode(cr)
}
