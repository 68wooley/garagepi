/* Copyright(C) 2017-2022, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * myq-api.ts: Our myQ API implementation.
 */
import { FetchError, Headers, context } from "@adobe/fetch";
import { MYQ_API_CLIENT_ID, MYQ_API_CLIENT_SECRET, MYQ_API_REDIRECT_URI } from "./settings.js";
import { parse } from "node-html-parser";
import pkceChallenge from "pkce-challenge";
import util from "node:util";
/*
 * The myQ API is undocumented, non-public, and has been derived largely through
 * reverse engineering the official app, myQ website, and trial and error.
 *
 * This project stands on the shoulders of the other myQ projects out there that have
 * done much of the heavy lifting of decoding the API.
 *
 * Starting with v6 of the myQ API, myQ now uses OAuth 2.0 + PKCE to authenticate users and
 * provide access tokens for future API calls. In order to successfully use the API, we need
 * to first authenticate to the myQ API using OAuth, get the access token, and use that for
 * future API calls.
 *
 * On the plus side, the myQ application identifier and HTTP user agent - previously pain
 * points for the community when they get seemingly randomly changed or blacklisted - are
 * no longer required.
 *
 * For those familiar with prior versions of the API, v6 does not represent a substantial
 * change outside of the shift in authentication type and slightly different endpoint
 * semantics. The largest non-authentication-related change relate to how commands are
 * sent to the myQ API to execute actions such as opening and closing a garage door, and
 * even those changes are relatively minor.
 *
 * The myQ API is clearly evolving and will continue to do so. So what's good about v6 of
 * the API? A few observations that will be explored with time and lots of experimentation
 * by the community:
 *
 *   - It seems possible to use guest accounts to now authenticate to myQ.
 *   - Cameras seem to be more directly supported.
 *   - Locks seem to be more directly supported.
 *
 * Overall, the workflow to using the myQ API should still feel familiar:
 *
 * 1. Login to the myQ API and acquire an OAuth access token.
 * 2. Enumerate the list of myQ devices, including gateways and openers. myQ devices like
 *    garage openers or lights are associated with gateways. While you can have multiple
 *    gateways in a home, a more typical setup would be one gateway per home, and one or
 *    more devices associated with that gateway.
 * 3. To check status of myQ devices, we periodically poll to get updates on specific
 *    devices.
 *
 * Those are the basics and gets us up and running. There are further API calls that
 * allow us to open and close openers, lights, and other devices, as well as periodically
 * poll for status updates.
 *
 * That last part is key. Since there is no way that we know of to monitor status changes
 * in real time, we have to resort to polling the myQ API regularly to see if something
 * has happened that we're interested in (e.g. a garage door opening or closing). It
 * would be great if a monitor API existed to inform us when changes occur, but alas,
 * it either doesn't exist or hasn't been discovered yet.
 */
const myQDomain = "myq-cloud.com";
const myQRegions = ["east", "west"];
export class myQApi {
    // Initialize this instance with our login information.
    constructor(email, password, log, region = "") {
        // If we didn't get passed a logging parameter, by default we log to the console.
        log = log ?? {
            /* eslint-disable no-console */
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            debug: (message, ...parameters) => { },
            error: (message, ...parameters) => console.error(util.format(message, ...parameters)),
            info: (message, ...parameters) => console.log(util.format(message, ...parameters)),
            warn: (message, ...parameters) => console.log(util.format(message, ...parameters))
            /* eslint-enable no-console */
        };
        this.accessToken = null;
        this.accounts = [];
        this.email = email;
        this.headers = new Headers();
        this.log = log;
        this.password = password;
        this.refreshInterval = 0;
        this.refreshToken = "";
        this.region = "";
        this.tokenScope = "";
        // Discern if we've been explicitly directed to a particular myQ cloud region.
        region = region.toLowerCase();
        this.region = myQRegions.some(x => x === region) ? region : "";
        // The myQ API v6 doesn't seem to require an HTTP user agent to be set - so we don't.
        const { fetch } = context({ alpnProtocols: ["h2" /* ALPNProtocol.ALPN_HTTP2 */], userAgent: "" });
        this.myqRetrieve = fetch;
    }
    // Transmit the PKCE challenge and retrieve the myQ OAuth authorization page to prepare to login.
    async oauthGetAuthPage(codeChallenge) {
        const authEndpoint = new URL("https://partner-identity" + this.myQCloud + "/connect/authorize");
        // Set the client identifier.
        authEndpoint.searchParams.set("client_id", "IOS_CGI_MYQ");
        // Set the PKCE code challenge.
        authEndpoint.searchParams.set("code_challenge", codeChallenge);
        // Set the PKCE code challenge method.
        authEndpoint.searchParams.set("code_challenge_method", "S256");
        // Set the redirect URI to the myQ app.
        authEndpoint.searchParams.set("redirect_uri", "com.myqops://ios");
        // Set the response type.
        authEndpoint.searchParams.set("response_type", "code");
        // Set the scope.
        authEndpoint.searchParams.set("scope", "MyQ_Residential offline_access");
        // Send the PKCE challenge and let's begin the login process.
        const response = await this.retrieve(authEndpoint.toString(), { redirect: "follow" }, true);
        if (!response) {
            this.log.error("myQ API: Unable to access the OAuth authorization endpoint.");
            return null;
        }
        return response;
    }
    // Login to the myQ API, using the retrieved authorization page.
    async oauthLogin(authPage) {
        // Grab the cookie for the OAuth sequence. We need to deal with spurious additions to the cookie that gets returned by the myQ API.
        const cookie = this.trimSetCookie(authPage.headers.raw()["set-cookie"]);
        // Parse the myQ login page and grab what we need.
        const htmlText = await authPage.text();
        const loginPageHtml = parse(htmlText);
        const requestVerificationToken = loginPageHtml.querySelector("input[name=__RequestVerificationToken]")?.getAttribute("value");
        if (!requestVerificationToken) {
            this.log.error("myQ API: Unable to complete OAuth login. The verification token could not be retrieved.");
            return null;
        }
        // Set the login info.
        const loginBody = new URLSearchParams({ "Email": this.email, "Password": this.password, "__RequestVerificationToken": requestVerificationToken });
        // Login and we're done.
        const response = await this.retrieve(authPage.url, {
            body: loginBody.toString(),
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Cookie": cookie
            },
            method: "POST",
            redirect: "manual"
        }, true);
        // An error occurred and we didn't get a good response.
        if (!response) {
            this.log.error("myQ API: Unable to complete OAuth login. Ensure your username and password are correct.");
            return null;
        }
        // If we don't have the full set of cookies we expect, the user probably gave bad login information.
        if (response.headers.raw()["set-cookie"].length < 2) {
            this.log.error("myQ API: Invalid myQ credentials given. Check your login and password.");
            return null;
        }
        return response;
    }
    // Intercept the OAuth login response to adjust cookie headers before sending on it's way.
    async oauthRedirect(loginResponse) {
        // Get the location for the redirect for later use.
        const redirectUrl = new URL(loginResponse.headers.get("location"), loginResponse.url);
        // Cleanup the cookie so we can complete the login process by removing spurious additions
        // to the cookie that gets returned by the myQ API.
        const cookie = this.trimSetCookie(loginResponse.headers.raw()["set-cookie"]);
        // Execute the redirect with the cleaned up cookies and we're done.
        const response = await this.retrieve(redirectUrl.toString(), {
            headers: {
                "Cookie": cookie
            },
            redirect: "manual"
        }, true);
        if (!response) {
            this.log.error("myQ API: Unable to complete the OAuth login redirect.");
            return null;
        }
        return response;
    }
    // Get a new OAuth access token.
    async getOAuthToken() {
        // Generate the OAuth PKCE challenge required for the myQ API.
        const pkce = pkceChallenge();
        // Call the myQ authorization endpoint using our PKCE challenge to get the web login page.
        let response = await this.oauthGetAuthPage(pkce.code_challenge);
        if (!response) {
            return null;
        }
        // Attempt to login.
        response = await this.oauthLogin(response);
        if (!response) {
            return null;
        }
        // Intercept the redirect back to the myQ iOS app.
        response = await this.oauthRedirect(response);
        if (!response) {
            return null;
        }
        // Parse the redirect URL to extract the PKCE verification code and scope.
        const redirectUrl = new URL(response.headers.get("location") ?? "");
        // Create the request to get our access and refresh tokens.
        const requestBody = new URLSearchParams({
            "client_id": MYQ_API_CLIENT_ID,
            "client_secret": Buffer.from(MYQ_API_CLIENT_SECRET, "base64").toString(),
            "code": redirectUrl.searchParams.get("code"),
            "code_verifier": pkce.code_verifier,
            "grant_type": "authorization_code",
            "redirect_uri": MYQ_API_REDIRECT_URI,
            "scope": redirectUrl.searchParams.get("scope")
        });
        // Now we execute the final login redirect that will validate the PKCE challenge and
        // return our access and refresh tokens.
        response = await this.retrieve("https://partner-identity" + this.myQCloud + "/connect/token", {
            body: requestBody.toString(),
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            method: "POST"
        }, true);
        if (!response) {
            this.log.error("myQ API: Unable to acquire an OAuth access token.");
            return null;
        }
        // Grab the token JSON.
        const token = await response.json();
        this.refreshInterval = token.expires_in;
        this.refreshToken = token.refresh_token;
        this.tokenScope = redirectUrl.searchParams.get("scope") ?? "";
        // Refresh our tokens at seven minutes before expiration as a failsafe.
        this.refreshInterval -= 420;
        // Ensure we never try to refresh more frequently than every five minutes.
        if (this.refreshInterval < 300) {
            this.refreshInterval = 300;
        }
        // Return the access token in cookie-ready form: "Bearer ...".
        return token.token_type + " " + token.access_token;
    }
    // Refresh our OAuth access token.
    async refreshOAuthToken() {
        // Create the request to refresh tokens.
        const requestBody = new URLSearchParams({
            "client_id": MYQ_API_CLIENT_ID,
            "client_secret": Buffer.from(MYQ_API_CLIENT_SECRET, "base64").toString(),
            "grant_type": "refresh_token",
            "redirect_uri": MYQ_API_REDIRECT_URI,
            "refresh_token": this.refreshToken,
            "scope": this.tokenScope
        });
        // Execute the refresh token request.
        const response = await this.retrieve("https://partner-identity" + this.myQCloud + "/connect/token", {
            body: requestBody.toString(),
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            method: "POST"
        }, true);
        if (!response) {
            return false;
        }
        // Grab the refresh token JSON.
        const token = await response.json();
        this.accessToken = token.token_type + " " + token.access_token;
        this.accessTokenTimestamp = Date.now();
        this.refreshInterval = token.expires_in;
        this.refreshToken = token.refresh_token;
        this.tokenScope = token.scope ?? this.tokenScope;
        // Refresh our tokens at seven minutes before expiration as a failsafe.
        this.refreshInterval -= 420;
        // Ensure we never try to refresh more frequently than every five minutes.
        if (this.refreshInterval < 300) {
            this.refreshInterval = 300;
        }
        // Update our authorization header.
        this.headers.set("Authorization", this.accessToken);
        this.log.debug("myQ API: Successfully refreshed the myQ API access token.");
        // We're done.
        return true;
    }
    // Log us into myQ and get an access token.
    async acquireAccessToken() {
        let firstConnection = true;
        const now = Date.now();
        // Reset the API call time.
        this.lastAuthenticateCall = now;
        // Clear out tokens from prior connections.
        if (this.accessToken) {
            firstConnection = false;
            this.accessToken = null;
            this.accounts = [];
        }
        // Login to the myQ API and get an OAuth access token for our session.
        const token = await this.getOAuthToken();
        if (!token) {
            return false;
        }
        const regionMsg = this.region ? " using the " + this.region + " myQ cloud region" : "";
        // On initial plugin startup, let the user know we've successfully connected.
        if (firstConnection) {
            this.log.info("myQ API: Successfully connected to the myQ API%s.", regionMsg);
        }
        else {
            this.log.debug("myQ API: Successfully reacquired a myQ API access token%s.", regionMsg);
        }
        this.accessToken = token;
        this.accessTokenTimestamp = now;
        // Add the token to our headers that we will use for subsequent API calls.
        this.headers.set("Authorization", this.accessToken);
        // Grab our account information for subsequent calls.
        if (!(await this.getAccounts())) {
            this.accessToken = null;
            this.accounts = [];
            return false;
        }
        // Success.
        return true;
    }
    // Refresh the myQ access token, if needed.
    async refreshAccessToken() {
        const now = Date.now();
        // We want to throttle how often we call this API to no more than once every 2 minutes.
        if ((now - this.lastAuthenticateCall) < (2 * 60 * 1000)) {
            return (this.accounts.length && this.accessToken) ? true : false;
        }
        // If we don't have a access token yet, acquire one.
        if (!this.accounts.length || !this.accessToken) {
            return await this.acquireAccessToken();
        }
        // Is it time to refresh? If not, we're good for now.
        if ((now - this.accessTokenTimestamp) < (this.refreshInterval * 1000)) {
            return true;
        }
        // Try refreshing our existing access token before resorting to acquiring a new one.
        if (await this.refreshOAuthToken()) {
            return true;
        }
        this.log.error("myQ API: Unable to refresh our access token. " +
            "This error can usually be safely ignored and will be resolved by acquiring a new access token.");
        // Now generate a new access token.
        if (!(await this.acquireAccessToken())) {
            return false;
        }
        return true;
    }
    // Get the list of myQ devices associated with an account.
    async refreshDevices() {
        const now = Date.now();
        // We want to throttle how often we call this API as a failsafe. If we call it more
        // than once every two seconds or so, bad things can happen on the myQ side leading
        // to potential account lockouts. The author definitely learned this one the hard way.
        if (this.lastRefreshDevicesCall && ((now - this.lastRefreshDevicesCall) < (2 * 1000))) {
            this.log.debug("myQ API: throttling refreshDevices API call. Using cached data from the past two seconds.");
            return this.devices ? true : false;
        }
        // Reset the API call time.
        this.lastRefreshDevicesCall = now;
        // Validate and potentially refresh our access token.
        if (!(await this.refreshAccessToken())) {
            return false;
        }
        // Update our account information, to see if we've added or removed access to any other devices.
        if (!(await this.getAccounts())) {
            this.accessToken = null;
            this.accounts = [];
            return false;
        }
        const newDeviceList = [];
        // Loop over all the accounts we know about.
        for (const accountId of this.accounts) {
            // Get the list of device information for this account.
            // eslint-disable-next-line no-await-in-loop
            const response = await this.retrieve("https://devices" + this.myQCloud + "/api/v5.2/Accounts/" + accountId + "/Devices");
            if (!response) {
                this.log.error("myQ API: Unable to update device status from the myQ API. Acquiring a new access token.");
                this.accessToken = null;
                this.accounts = [];
                return false;
            }
            // Now let's get our account information.
            // eslint-disable-next-line no-await-in-loop
            const data = await response.json();
            this.log.debug(util.inspect(data, { colors: true, depth: 10, sorted: true }));
            newDeviceList.push(...data.items);
        }
        // Notify the user about any new devices that we've discovered.
        if (newDeviceList) {
            for (const newDevice of newDeviceList) {
                // We already know about this device.
                if (this.devices?.some((x) => x.serial_number === newDevice.serial_number)) {
                    continue;
                }
                // We've discovered a new device.
                this.log.info("myQ API: Discovered device family %s: %s.", newDevice.device_family, this.getDeviceName(newDevice));
            }
        }
        // Notify the user about any devices that have disappeared.
        if (this.devices) {
            for (const existingDevice of this.devices) {
                // This device still is visible.
                if (newDeviceList?.some((x) => x.serial_number === existingDevice.serial_number)) {
                    continue;
                }
                // We've had a device disappear.
                this.log.info("myQ API: Removed device family %s: %s.", existingDevice.device_family, this.getDeviceName(existingDevice));
            }
        }
        // Save the updated list of devices.
        this.devices = newDeviceList;
        return true;
    }
    // Execute an action on a myQ device.
    async execute(device, command) {
        // Validate and potentially refresh our access token.
        if (!(await this.refreshAccessToken())) {
            return false;
        }
        let response;
        // Ensure we cann the right endpoint to execute commands depending on device family.
        if (device.device_family === "lamp") {
            // Execute a command on a lamp device.
            response = await this.retrieve("https://account-devices-lamp" + this.myQCloud + "/api/v5.2/Accounts/" + device.account_id +
                "/lamps/" + device.serial_number + "/" + command, { method: "PUT" });
        }
        else {

            // By default, we assume we're targeting a garage door opener.
            if (device.serial_number === "CG0846B0D2F2"){
                //Intercept a call to open or close the Marantec double door garage which 
                //is incompatible with MyQ and use the local webservice to trigger the remote
                //opener button via a relay and GPIO
                response = await this.retrieve("http://localhost:9002/garagepi/v1/button1", { method: "GET" }, false, false);
            }else{
                response = await this.retrieve("https://account-devices-gdo" + this.myQCloud + "/api/v5.2/Accounts/" + device.account_id +
                "/door_openers/" + device.serial_number + "/" + command, { method: "PUT" });
            }
        }
        // Check for errors.
        if (!response) {
            this.log.error("myQ API: Unable to send the command to myQ servers. Acquiring a new access token.");
            this.accessToken = null;
            this.accounts = [];
            return false;
        }
        return true;
    }
    // Get our myQ account information.
    async getAccounts() {
        // Get the account information.
        const response = await this.retrieve("https://accounts" + this.myQCloud + "/api/v6.0/accounts");
        if (!response) {
            this.log.error("myQ API: Unable to retrieve account information.");
            return false;
        }
        // Now let's get our account information.
        const data = await response.json();
        this.log.debug(util.inspect(data, { colors: true, depth: 10, sorted: true }));
        // No account information returned.
        if (!data?.accounts) {
            this.log.error("myQ API: Unable to retrieve account information from the myQ API.");
            return false;
        }
        // Save all the account identifiers we know about for later use.
        this.accounts = data.accounts.map(x => x.id);
        return true;
    }
    // Utility to retrieve our domain.
    get myQCloud() {
        return (this.region.length ? "-" + this.region : "") + "." + myQDomain;
    }
    // Get the details of a specific device in the myQ device list.
    getDevice(serial) {
        // Check to make sure we have fresh information from myQ. If it's less than a minute
        // old, it looks good to us.
        if (!this.devices || !this.lastRefreshDevicesCall || ((Date.now() - this.lastRefreshDevicesCall) > (60 * 1000))) {
            return null;
        }
        // If we've got no serial number, we're done here.
        if (serial.length <= 0) {
            return null;
        }
        // Convert to upper case before searching for it.
        serial = serial.toUpperCase();
        // Iterate through the list and find the device that matches the serial number we seek.
        return this.devices.find(x => x.serial_number?.toUpperCase() === serial) ?? null;
    }
    // Utility to generate a nicely formatted device string.
    getDeviceName(device) {
        // A completely enumerated device will appear as:
        // DeviceName [DeviceBrand] (serial number: Serial, gateway: GatewaySerial).
        let deviceString = device.name;
        const hwInfo = this.getHwInfo(device.serial_number);
        if (hwInfo) {
            deviceString += " [" + hwInfo.brand + " " + hwInfo.product + "]";
        }
        if (device.serial_number) {
            deviceString += " (serial number: " + device.serial_number;
            if (device.parent_device_id) {
                deviceString += ", gateway: " + device.parent_device_id;
            }
            deviceString += ")";
        }
        return deviceString;
    }
    // Return device manufacturer and model information based on the serial number, if we can.
    getHwInfo(serial) {
        // We only know about gateway devices and not individual openers, so we can only decode those.
        // According to Liftmaster, here's how you can decode what device you're using:
        //
        // The MyQ serial number for the Wi-Fi GDO, MyQ Home Bridge, MyQ Smart Garage Hub,
        // MyQ Garage (Wi-Fi Hub) and Internet Gateway is 12 characters long. The first two characters,
        // typically "GW", followed by 2 characters that are decoded according to the table below to
        // identify the device type and brand, with the remaining 8 characters representing the serial number.
        const HwInfo = {
            "00": { brand: "Chamberlain", product: "Ethernet Gateway" },
            "01": { brand: "Liftmaster", product: "Ethernet Gateway" },
            "02": { brand: "Craftsman", product: "Ethernet Gateway" },
            "03": { brand: "Chamberlain", product: "WiFi Hub" },
            "04": { brand: "Liftmaster", product: "WiFi Hub" },
            "05": { brand: "Craftsman", product: "WiFi Hub" },
            "0A": { brand: "Chamberlain", product: "WiFi GDO AC" },
            "0B": { brand: "Liftmaster", product: "WiFi GDO AC" },
            "0C": { brand: "Craftsman", product: "WiFi GDO AC" },
            "0D": { brand: "myQ Replacement Logic Board", product: "WiFi GDO AC" },
            "0E": { brand: "Chamberlain", product: "WiFi GDO AC 3/4 HP" },
            "0F": { brand: "Liftmaster", product: "WiFi GDO AC 3/4 HP" },
            "10": { brand: "Craftsman", product: "WiFi GDO AC 3/4 HP" },
            "11": { brand: "myQ Replacement Logic Board", product: "WiFi GDO AC 3/4 HP" },
            "12": { brand: "Chamberlain", product: "WiFi GDO DC 1.25 HP" },
            "13": { brand: "Liftmaster", product: "WiFi GDO DC 1.25 HP" },
            "14": { brand: "Craftsman", product: "WiFi GDO DC 1.25 HP" },
            "15": { brand: "myQ Replacement Logic Board", product: "WiFi GDO DC 1.25 HP" },
            "20": { brand: "Chamberlain", product: "myQ Home Bridge" },
            "21": { brand: "Liftmaster", product: "myQ Home Bridge" },
            "23": { brand: "Chamberlain", product: "Smart Garage Hub" },
            "24": { brand: "Liftmaster", product: "Smart Garage Hub" },
            "27": { brand: "Liftmaster", product: "WiFi Wall Mount Opener" },
            "28": { brand: "Liftmaster Commercial", product: "WiFi Wall Mount Operator" },
            "80": { brand: "Liftmaster EU", product: "Ethernet Gateway" },
            "81": { brand: "Chamberlain EU", product: "Ethernet Gateway" }
        };
        if (serial?.length < 4) {
            return null;
        }
        // Use the third and fourth characters as indices into the hardware matrix. Admittedly,
        // we don't have a way to resolve the first two characters to ensure we are matching
        // against the right category of devices.
        return (HwInfo[serial[2] + serial[3]]) ?? null;
    }
    // Utility function to return the relevant portions of the cookies used in the login process.
    trimSetCookie(setCookie) {
        // Let's make sure we're operating on an array that's passed back as a header.
        if (!Array.isArray(setCookie)) {
            setCookie = [setCookie];
        }
        // We need to strip spurious additions to the cookie that gets returned by the myQ API.
        return setCookie.map(x => x.split(";")[0]).join("; ");
    }
    // Utility to let us streamline error handling and return checking from the myQ API.
    async retrieve(url, options = {}, overrideHeaders = false, decodeResponse = true, isRetry = false) {
        const isRedirect = (code) => [301, 302, 303, 307, 308].some(x => x === code);
        let response;
        // Set our headers.
        if (!overrideHeaders) {
            options.headers = this.headers;
        }
        try {
            response = await this.myqRetrieve(url, options);
            // The caller will sort through responses instead of us.
            if (!decodeResponse) {
                return response;
            }
            // Bad username and password.
            if (response.status === 401) {
                this.log.error("myQ API: Invalid myQ credentials given. Check your login and password.");
                return null;
            }
            // Some other unknown error occurred.
            if (!response.ok && !isRedirect(response.status)) {
                this.log.error("myQ API: %s Error: %s %s", url, response.status, response.statusText);
                return null;
            }
            return response;
        }
        catch (error) {
            if (error instanceof FetchError) {
                switch (error.code) {
                    case "ECONNREFUSED":
                        this.log.error("myQ API: Connection refused.");
                        break;
                    case "ECONNRESET":
                        // Retry on connection reset, but no more than once.
                        if (!isRetry) {
                            this.log.debug("myQ API: Connection has been reset. Retrying the API action.");
                            return this.retrieve(url, options, overrideHeaders, decodeResponse, true);
                        }
                        this.log.error("myQ API: Connection has been reset.");
                        break;
                    case "ENOTFOUND":
                        this.log.error("myQ API: Hostname or IP address not found.");
                        break;
                    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
                        this.log.error("myQ API: Unable to verify the myQ TLS security certificate.");
                        break;
                    default:
                        this.log.error(error.message);
                }
            }
            else {
                this.log.error("Unknown fetch error: %s", error);
            }
            return null;
        }
    }
}
//# sourceMappingURL=myq-api.js.map