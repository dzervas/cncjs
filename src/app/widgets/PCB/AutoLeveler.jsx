import PropTypes from 'prop-types';
import React, { PureComponent } from 'react';

import {
    // Units
    IMPERIAL_UNITS,
    METRIC_UNITS,
    // Controllers
    GRBL
} from 'app/constants';
import controller from 'app/lib/controller';
import i18n from 'app/lib/i18n';
import log from 'app/lib/log';
import WidgetConfig from 'app/widgets/WidgetConfig';

import { startAutolevel, applyCompensation } from './lib/autoLevel';
import ConfirmModal from './ConfirmModal';

class AutoLeveler extends PureComponent {
    static propTypes = {
        widgetId: PropTypes.string.isRequired,
        // onFork: PropTypes.func.isRequired,
        // onRemove: PropTypes.func.isRequired,
        // sortable: PropTypes.object
    };

    config = new WidgetConfig(this.props.widgetId);

    state = this.getInitialState();

    actions = {
        // TODO: Save to store
        onChangeMargin: (event) => {
            this.setState({ margin: event.target.value });
        },

        onChangeZSafe: (event) => {
            this.setState({ zSafe: event.target.value });
        },

        onChangeDelta: (event) => {
            this.setState({ delta: event.target.value });
        },

        onChangeFeedrate: (event) => {
            this.setState({ feedrate: event.target.value });
        }
    }

    // TODO: Intercept all writes and autolevel them
    controllerEvent = {
        'controller:state': (controllerType, controllerState) => {
            if (controllerType === GRBL) {
                const {
                    status: { wco },
                    parserstate: { modal = {} }
                } = controllerState;

                // Units
                const units = {
                    'G20': IMPERIAL_UNITS,
                    'G21': METRIC_UNITS
                }[modal.units] || this.state.units;

                this.setState(state => ({
                    units: units,
                    wco
                }));
            }
        },
        // TODO: Execute the following even if gcode is already loaded
        'gcode:load': (name, gcode) => {
            // Tiny gcode parser to calculate bounding box.
            // If this ext gets integrated to cncjs use `gcode:bbox` pubsub event
            // TODO: Ask if mesh should be deleted

            if (name.indexOf('#AL:') === 0) {
                log.warn(`Skipping gcode load of ${name} as it's pre-leveled`);
                return;
            }

            let xmin = null;
            let xmax = null;
            let ymin = null;
            let ymax = null;

            gcode.split('\n').forEach(line => {
                if (line[0] !== 'G') {
                    return;
                }

                let cmd = parseInt(line.substr(1, 2), 10);
                if (cmd !== 0 && cmd !== 1 && cmd !== 2 && cmd !== 3 && cmd !== 38) {
                    return;
                }

                let parser = /(?:\s?([XY]-?[0-9.]+)+)/g;

                for (const matchGroups of [...line.matchAll(parser)]) {
                    const match = matchGroups[1];
                    let num = parseFloat(match.substr(1));
                    if (match[0] === 'X') {
                        if (num > xmax || xmax === null) {
                            xmax = num;
                        }
                        if (num < xmin || xmin === null) {
                            xmin = num;
                        }
                    } else if (match[0] === 'Y') {
                        if (num > ymax || ymax === null) {
                            ymax = num;
                        }
                        if (num < ymin || ymin === null) {
                            ymin = num;
                        }
                    }
                }
            });

            // TODO: Show it in the UI
            log.info(`New BBox: xmin: ${xmin} xmax: ${xmax} ymin: ${ymin} ymax: ${ymax}`);
            this.setState({
                gcode,
                gcodeFileName: name,
                bbox: {
                    min: { x: xmin, y: ymin },
                    max: { x: xmax, y: ymax }
                },
                // TODO: Make these configurable
                alignmentHole: [
                    { x: xmin - 1, y: ymax / 2 },
                    { x: xmax + 1, y: ymax / 2 }
                ]
            });
            log.info(`New Alignment Holes: left X ${this.state.alignmentHole[0].x} Y ${this.state.alignmentHole[0].y} right X ${this.state.alignmentHole[0].x} Y ${this.state.alignmentHole[0].y}`);
            this.setState({ gcodeLoaded: true });
        },
        'gcode:unload': () => {
            this.setState({
                confirmModal: {
                    show: true,
                    title: 'PCB Factory',
                    subtitle: `Do you want to unload the current mesh of the file "${this.state.gcodeFileName}"`,
                    onConfirm: () => {
                        this.setState({ gcodeLoaded: false, gcode: '' });
                    }
                }
            });
        },
        'serialport:read': (data) => {
            // TODO: Return a promise? or at the "start level" thing?
            // TODO: Add/remove this listener as needed

            if (this.state.isAutolevelRunning && this.state.plannedPointCount <= this.state.probedPoints.length) {
                this.setState({ isAutolevelRunning: false });
                return;
            }

            if (!this.state.isAutolevelRunning || this.state.plannedPointCount <= this.state.probedPoints.length || data.indexOf('PRB') < 0) {
                return;
            }

            // TODO: Add support for the rest of the controllers
            let prbm = /\[PRB:([\+\-\.\d]+),([\+\-\.\d]+),([\+\-\.\d]+),?([\+\-\.\d]+)?:(\d)\]/g.exec(data);
            if (!prbm) {
                return;
            }

            let prb = [
                parseFloat(prbm[1]),
                parseFloat(prbm[2]),
                parseFloat(prbm[3])
            ];
            let pt = {
                x: prb[0] - this.state.wco.x,
                y: prb[1] - this.state.wco.y,
                z: prb[2] - this.state.wco.z
            };

            if (this.state.plannedPointCount <= 0) {
                return;
            }

            if (this.state.probedPoints.length === 0) {
                this.min_dz = pt.z;
                this.max_dz = pt.z;
                this.sum_dz = pt.z;
            } else {
                if (pt.z < this.min_dz) {
                    this.min_dz = pt.z;
                }
                if (pt.z > this.max_dz) {
                    this.max_dz = pt.z;
                }
                this.sum_dz += pt.z;
            }

            this.state.probedPoints.push(pt);
            log.info(`Probed ${this.state.probedPoints.length}/${this.state.plannedPointCount}> ${pt.x.toFixed(3)} ${pt.y.toFixed(3)} ${pt.z.toFixed(3)}`);
            // send info to console
            if (this.state.probedPoints.length >= this.state.plannedPointCount) {
                applyCompensation(this.state.gcode, this.state.probedPoints, this.state.delta);
                this.setState({ plannedPointCount: 0 });
            }
        }
    }

    getInitialState() {
        return {
            confirmModal: {
                show: false,
                title: 'PCB Autoleveler',
                subtitle: '',
                onConfirm: () => {}
            },

            units: METRIC_UNITS,
            gcode: '',
            gcodeFileName: '',
            wco: {
                x: 0.000,
                y: 0.000,
                z: 0.000
            },
            bbox: {
                min: {
                    x: undefined,
                    y: undefined
                },
                max: {
                    x: undefined,
                    y: undefined
                }
            },
            // TODO: Do something with it
            alignmentHole: [
                { x: undefined, y: undefined },
                { x: undefined, y: undefined }
            ],
            // TODO: Retrieve from store
            isAutolevelRunning: false,
            delta: this.config.get('delta', 10.0),
            zSafe: this.config.get('zsafe', 2.0),
            feedrate: this.config.get('feedrate', 25),
            margin: this.config.get('feedrate', 2.5),
            gcodeLoaded: false,

            plannedPointCount: 0,
            probedPoints: []
        };
    }

    componentDidMount() {
        this.addControllerEvents();
    }

    componentWillUnmount() {
        this.removeControllerEvents();
    }

    componentDidUpdate(prevProps, prevState) {
        const {
            margin,
            zSafe,
            delta,
            feedrate
        } = this.state;

        this.config.set('margin', margin);
        this.config.set('zsafe', zSafe);
        this.config.set('delta', delta);
        this.config.set('feedrate', feedrate);
    }

    addControllerEvents() {
        Object.keys(this.controllerEvent).forEach(eventName => {
            const callback = this.controllerEvent[eventName];
            controller.addListener(eventName, callback);
        });
    }

    removeControllerEvents() {
        Object.keys(this.controllerEvent).forEach(eventName => {
            const callback = this.controllerEvent[eventName];
            controller.removeListener(eventName, callback);
        });
    }

    render() {
        const actions = { ...this.actions };
        const {
            bbox,
            margin,
            zSafe,
            delta,
            feedrate,
            isAutolevelRunning,
            confirmModal,
            gcodeLoaded,
            gcodeFileName
        } = this.state;
        const isDisabled = isAutolevelRunning ||
            this.state.bbox.max.x === undefined ||
            this.state.bbox.max.y === undefined ||
            this.state.bbox.min.x === undefined ||
            this.state.bbox.min.y === undefined;

        return (
            <div>
                <div className="form-group">
                    <label className="control-label">{i18n._('Loaded G-code')}</label>
                    <div className="input-group input-group-sm">
                        <input
                            type="text"
                            className="form-control"
                            value={gcodeLoaded && gcodeFileName}
                            disabled={true}
                        />
                    </div>

                    <label className="control-label">{i18n._('Margins')}</label>
                    <div className="input-group input-group-sm">
                        <input
                            type="number"
                            className="form-control"
                            step="0.5"
                            min="0"
                            defaultValue={margin}
                            disabled={isDisabled}
                            onChange={actions.onChangeMargin}
                        />
                    </div>

                    <label className="control-label">{i18n._('Z Safe')}</label>
                    <div className="input-group input-group-sm">
                        <input
                            type="number"
                            className="form-control"
                            step="0.5"
                            min="0.5"
                            defaultValue={zSafe}
                            disabled={isDisabled}
                            onChange={actions.onChangeZSafe}
                        />
                    </div>

                    <label className="control-label">{i18n._('Delta')}</label>
                    <div className="input-group input-group-sm">
                        <input
                            type="number"
                            className="form-control"
                            step="1"
                            min="1"
                            defaultValue={delta}
                            disabled={isDisabled}
                            onChange={actions.onChangeDelta}
                        />
                    </div>

                    <label className="control-label">{i18n._('Feedrate')}</label>
                    <div className="input-group input-group-sm">
                        <input
                            type="number"
                            className="form-control"
                            step="10"
                            min="1"
                            defaultValue={feedrate}
                            disabled={isDisabled}
                            onChange={actions.onChangeFeedrate}
                        />
                    </div>

                    {/*
                    <label className="control-label">{i18n._('Left Alignment Hole')}</label>
                    <div className="input-group input-group-xs">
                        <input
                            type="number"
                            className="form-control"
                            value={this.state.alignmentHole[0].x}
                            disabled={true}
                        />
                        <input
                            type="number"
                            className="form-control"
                            value={this.state.alignmentHole[0].y}
                            disabled={true}
                        />
                    </div>
                    <label className="control-label">{i18n._('Right Alignment Hole')}</label>
                    <div className="input-group input-group-xs">
                        <input
                            type="number"
                            className="form-control"
                            value={this.state.alignmentHole[1].x}
                            disabled={true}
                        />
                        <input
                            type="number"
                            className="form-control"
                            value={this.state.alignmentHole[1].y}
                            disabled={true}
                        />
                    </div>
                    */}

                </div>
                <div className="form-group">
                    <div className="btn-group btn-group-sm">
                        <button
                            type="button"
                            className="btn btn-primary"
                            disabled={isDisabled}
                            onClick={() => {
                                this.setState({ isAutolevelRunning: true });
                                // TODO: Move this to its clear function
                                this.setState({ plannedPointCount: 0, probedPoints: [] });
                                const plannedPointCount = startAutolevel(bbox, margin, delta, zSafe, feedrate);
                                this.setState({ plannedPointCount });
                            }}
                        >
                            {i18n._('Run Autolevel')}
                        </button>
                    </div>
                </div>
                { confirmModal.show && (
                    <ConfirmModal
                        title={confirmModal.title}
                        subtitle={confirmModal.subtitle}
                        onConfirm={confirmModal.onConfirm}
                        onClose={() => {
                            this.setState({ confirmModal: { show: false } });
                        }}
                    />
                ) }
            </div>
        );
    }
}

export default AutoLeveler;
