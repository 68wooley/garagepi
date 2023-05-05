package main

import (
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/68wooley/garagepi/appconfig"
	"github.com/68wooley/garagepi/garagepiservice"
	"github.com/68wooley/garagepi/utils"

	"github.com/gorilla/mux"
	"github.com/rs/cors"
)

var (
	WarningLogger *log.Logger
	InfoLogger    *log.Logger
	ErrorLogger   *log.Logger
)

func initLogging() {

	//Get the process ID for log messages
	pid := strconv.Itoa(os.Getpid())

	file, err := os.OpenFile(appconfig.ConfigData.LogFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0666)
	if err != nil {
		msg := "Garaegepi encountered an unexpected error initiating the logging system at : " + time.Now().Format("2006-01-02 15:04:05") + "\r\n\r\n" + err.Error()
		log.Fatalln(msg)
	}

	InfoLogger = log.New(file, "INFO ("+pid+"): ", log.Ldate|log.Ltime|log.Lshortfile)
	WarningLogger = log.New(file, "WARNING ("+pid+"): ", log.Ldate|log.Ltime|log.Lshortfile)
	ErrorLogger = log.New(file, "ERROR ("+pid+"): ", log.Ldate|log.Ltime|log.Lshortfile)

	garagepiservice.ErrorLogger = ErrorLogger
	garagepiservice.InfoLogger = InfoLogger
	garagepiservice.WarningLogger = WarningLogger
}

func main() {

	//Read the config file
	_, err := appconfig.ReadConfig()
	if err != nil {
		msg := "Garagepi encountered an unexpected result reading the config file at: " + time.Now().Format("2006-01-02 15:04:05") + "\r\n\r\n" + err.Error()
		log.Fatal(msg)
	}

	initLogging()

	//Check PID File
	for {
		if err := utils.CheckPIDFile(appconfig.ConfigData.PIDFile); err != nil {
			msg := "A prior garagepi process is still running - waiting 30 seconds then trying again : " + time.Now().Format("2006-01-02 15:04:05") + ": " + err.Error() + "\r\n\r\n"
			WarningLogger.Print(msg)
			time.Sleep(30 * time.Second)
		} else {
			break
		}
	}

	//initialize router
	router := mux.NewRouter()

	//endpoints
	//Check Status of Investigations, creating / removing workflow tasks and email notifications as needed
	router.HandleFunc("/garagepi/v1/button1", garagepiservice.PressButton1).Methods("GET")
	router.HandleFunc("/garagepi/v1/button2", garagepiservice.PressButton2).Methods("GET")

	handler := cors.Default().Handler(router)

	InfoLogger.Fatal(http.ListenAndServe(":"+appconfig.ConfigData.ServicePort, handler))

}
