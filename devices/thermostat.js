const RingSocketDevice = require('./base-socket-device')
const { RingDeviceType } = require('ring-client-api')

class Thermostat extends RingSocketDevice {
    constructor(deviceInfo, allDevices) {
        super(deviceInfo, 'alarm')
        this.deviceData.mdl = 'Thermostat'

        this.childDevices = {
            operatingStatus: allDevices.find(d => d.data.parentZid === this.device.id && d.deviceType === 'thermostat-operating-status'),
            temperatureSensor: allDevices.find(d => d.data.parentZid === this.device.id && d.deviceType === RingDeviceType.TemperatureSensor)
        }

        this.entity.thermostat = {
            component: 'climate',
            modes: Object.keys(this.device.data.modeSetpoints).filter(mode => ["off", "cool", "heat", "auto"].includes(mode)),
            fan_modes: this.device.data.hasOwnProperty('supportedFanModes')
                ? this.device.data.supportedFanModes.map(f => f.charAt(0).toUpperCase() + f.slice(1))
                : ["Auto"]
        }

        this.data = {
            mode: (() => { return this.device.data.mode === 'aux' ? 'heat' : this.device.data.mode }),
            fanMode: (() => { return this.device.data.fanMode.replace(/^./, str => str.toUpperCase()) }),
            auxMode: (() => { return this.device.data.mode === 'aux' ? 'ON' : 'OFF' }),
            setPoint: (() => {
                return this.device.data.setPoint
                    ? this.device.data.setPoint.toString()
                    : this.childDevices.temperatureSensor.data.celsius.toString() 
                }),
            operatingMode: (() => { 
                return this.childDevices.operatingStatus.data.operatingMode !== 'off'
                    ? `${this.childDevices.operatingStatus.data.operatingMode}ing`
                    : this.device.data.mode === 'off'
                        ? 'off'
                        : this.device.data.fanMode === 'on' ? 'fan' : 'idle' 
                }),
            temperature: (() => { return this.childDevices.temperatureSensor.data.celsius.toString() })
        }

        this.childDevices.operatingStatus.onData.subscribe(() => { 
            if (this.isOnline()) { 
                this.publishOperatingMode()
                this.publishAttributes()
            }
        })

        this.childDevices.temperatureSensor.onData.subscribe(() => {
            if (this.isOnline()) { 
                this.publishTemperature()
                this.publishAttributes()
            }
        })
    }

    async publishData(data) {
        const isPublish = data === undefined ? true : false
        const mode = this.data.mode()

        this.publishMqtt(this.entity.thermostat.mode_state_topic, mode)
        if (mode === 'auto') {
            const deadBand = this.data.modeSetpoints.auto.deadBand ? this.data.modeSetpoints.auto.deadBand : 1.5
            const setPoint = this.data.setPoint()
            this.publishMqtt(this.entity.thermostat.temperature_high_state_topic, setPoint+deadBand)
            this.publishMqtt(this.entity.thermostat.temperature_low_state_topic, setPoint-deadBand)
        } else {
            this.publishMqtt(this.entity.thermostat.temperature_state_topic, this.data.setPoint())
        }
        this.publishMqtt(this.entity.thermostat.fan_mode_state_topic, this.data.fanMode())
        this.publishMqtt(this.entity.thermostat.aux_state_topic, this.data.auxMode())
        this.publishOperatingMode()

        if (isPublish) { this.publishTemperature() }
        this.publishAttributes()
    }

    publishOperatingMode() {
        this.publishMqtt(this.entity.thermostat.action_topic, this.data.operatingMode())
    }

    publishTemperature() {
        this.publishMqtt(this.entity.thermostat.current_temperature_topic, this.data.temperature())
    }

    // Process messages from MQTT command topic
    processCommand(message, componentCommand) {
        switch (componentCommand) {
            case 'thermostat/mode_command':
                this.setMode(message)
                break;
            case 'thermostat/temperature_command':
                this.setSetPoint(message)
                break;
            case 'thermostat/temperature_high_command':
                this.setAutoSetPoint(message, 'high')
                break;
            case 'thermostat/temperature_low_command':
                this.setAutoSetPoint(message, 'low')
                break;
            case 'thermostat/fan_mode_command':
                this.setFanMode(message)
                break;
            case 'thermostat/aux_command':
                this.setAuxMode(message)
                break;
            default:
                this.debug(`Received message to unknown command topic: ${componentCommand}`)
        }
    }

    async setMode(value) {
        this.debug(`Received set mode ${value}`)
        const mode = value.toLowerCase()
        switch(mode) {
            case 'off':
                this.publishMqtt(this.entity.thermostat.action_topic, mode)
            case 'cool':
            case 'heat':
            case 'auto':
            case 'aux':
                if (this.entity.thermostat.modes.map(e => e.toLocaleLowerCase()).includes(mode) || mode === 'aux') {
                    this.device.setInfo({ device: { v1: { mode } } })
                    this.publishMqtt(this.entity.thermostat.mode_state_topic, mode)
                }
                break;
            default:
                this.debug(`Received invalid set mode command`)
        }
    }
    
    async setSetPoint(value) {
        this.debug(`Received set target temperature to ${value}`)
        if (isNaN(value)) {
            this.debug('New temperature set point received but is not a number!')
        } else if (!(value >= 10 && value <= 37.22223)) {
            this.debug('New temperature set point received but is out of range (10-37.22223°C)!')
        } else {
            this.device.setInfo({ device: { v1: { setPoint: Number(value) } } })
            this.publishMqtt(this.entity.thermostat.temperature_state_topic, value)
        }
    }

    async setAutoSetPoint(value, type) {
        this.debug(`Received set target ${type} temperature to ${value}`)
        if (isNaN(value)) {
            this.debug(`New ${type} temperature set point received but is not a number!`)
        } else if (!(value >= 10 && value <= 37.22223)) {
            this.debug(`New ${type} temperature set point received but is out of range (10-37.22223°C)!`)
        } else {
            const setPoint = this.data.setPoint()
            const deadBand = this.data.modeSetpoints.auto.deadBand ? this.data.modeSetpoints.auto.deadBand : 1.5
            const targetHighSetpoint = (type === 'high') ? value : setPoint+deadBand
            const targetLowSetpoint = (type === 'low') ? value : setPoint+deadBand
            const targetSetpoint = (targetHighSetpoint+targetLowSetpoint)/2
            const targetDeadBand = targetHighSetpoint-targetSetpoint

            if (targetDeadBand >= 1.5) {
                this.device.setInfo({ device: { v1: { setPoint: Number(targetSetpoint), deadBand: Number(targetDeadBand) } } })
                this.publishMqtt(this.entity.thermostat.temperature_high_state_topic, targetHighSetpoint)
                this.publishMqtt(this.entity.thermostat.temperature_low_state_topic, targetLowSetpoint)
            } else {
                this.debug(`New ${type} temperature set point would be below the allowed deadBand range ${this.data.modeSetpoints.auto.deadBandMin}`)
            }
        }
    }

    async setFanMode(value) {
        this.debug(`Recevied set fan mode ${value}`)
        const fanMode = value.toLowerCase()
        if (this.entity.thermostat.fan_modes.map(e => e.toLocaleLowerCase()).includes(fanMode)) {
            this.device.setInfo({ device: { v1: { fanMode }}})
            this.publishMqtt(this.entity.thermostat.fan_mode_state_topic, fanMode.replace(/^./, str => str.toUpperCase()))
        } else {
            this.debug('Received invalid fan mode command')
        }
    }

    async setAuxMode(value) {
        this.debug(`Received set aux mode ${value}`)
        const auxMode = value.toLowerCase()
        switch(auxMode) {
            case 'on':
            case 'off':
                const mode = auxMode === 'on' ? 'aux' : 'heat'
                this.device.setInfo({ device: { v1: { mode } } })
                this.publishMqtt(this.entity.thermostat.aux_state_topic, auxMode.toUpperCase())
                break;
            default:
                this.debug('Received invalid aux mode command')
        }
    }
}

module.exports = Thermostat