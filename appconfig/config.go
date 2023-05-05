package appconfig

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"log"
)

// AppConfig contains config settings
type AppConfig struct {
	Debug                bool   `json:"DEBUG"`
	LogFile              string `json:"LOGFILE"`
	PIDFile              string `json:"PIDFILE"`
	ServicePort          string `json:"SERVICEPORT"`
	ProxyURL             string `json:"PROXYURL"`
	Button1GPIOPin       string `json:"BUTTON1GPIOPIN"`
	Button2GPIOPin       string `json:"BUTTON2GPIOPIN"`
	Button1PressDuration string `json:"BUTTON1PRESSDURATION"`
	Button2PressDuration string `json:"BUTTON2PRESSDURATION"`
}

// ConfigData contains application configuration settings read from a JSON formatted file.
var ConfigData AppConfig

// ReadConfig
func ReadConfig() (configjson string, err error) {

	//read the config file
	data, err := ioutil.ReadFile("config.json")
	if err != nil {
		log.Fatalf("Error reading config file: %s", err)
	}
	err = json.Unmarshal(data, &ConfigData)
	if err != nil {
		log.Fatalf("Error unmarshalling config file: %s", err)
	}
	return string(data), nil
}

// SaveConfig
func SaveConfig(newJSON string) (configjson string, err error) {

	//read the config file
	var tmp AppConfig
	err = json.Unmarshal([]byte(newJSON), &tmp)
	if err != nil {
		return "", fmt.Errorf("Error unmarshalling new Settings JSON: %s", err)
	}
	//Write to the file
	err = ioutil.WriteFile("config.json", []byte(newJSON), 0644)
	if err != nil {
		return "", fmt.Errorf("Error writing to config.json: %s", err)
	}

	ConfigData = tmp
	return newJSON, nil
}
