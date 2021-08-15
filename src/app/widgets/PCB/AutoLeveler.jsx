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

import { applyCompensation, calculateBBox, generateAutolevelGcode } from './lib/autoLevel';
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
            this.setState({ margin: parseFloat(event.target.value) });
        },

        onChangeZSafe: (event) => {
            this.setState({ zSafe: parseFloat(event.target.value) });
        },

        onChangeDelta: (event) => {
            this.setState({ delta: parseFloat(event.target.value) });
        },

        onChangeFeedrate: (event) => {
            this.setState({ feedrate: parseFloat(event.target.value) });
        },

        doProbeArea: (_event, force = false) => {
            log.debug(`doProbeArea: force ${force} points ${JSON.stringify(this.state.probedPoints)} gcodeLoaded ${this.state.gcodeLoaded}`);
            if (this.state.probedPoints.length > 0 && this.state.gcodeLoaded && !force) {
                this.setState({
                    confirmModal: {
                        show: true,
                        title: 'PCB Autoleveler',
                        subtitle: `Do you want to clear the current mesh of the file "${this.state.gcodeFileName}" and probe the area again to generate it?`,
                        onConfirm: () => {
                            this.actions.doProbeArea(_event, true);
                        }
                    }
                });
                return;
            }

            const {
                bbox,
                margin,
                delta,
                zSafe,
                feedrate
            } = this.state;

            const { plannedPointCount, code } = generateAutolevelGcode(bbox, margin, delta, zSafe, feedrate);

            this.setState({
                confirmModal: {
                    show: true,
                    title: 'PCB Autoleveler',
                    subtitle: (
                        <div>
                            <div style={{ marginBottom: 10 }}>
                                Send the following G-code to generate mesh for &quot;{this.state.gcodeFileName}&quot;?
                            </div>
                            <pre style={{ minHeight: 240 }}>
                                <code>{code.join('\n')}</code>
                            </pre>
                        </div>
                    ),
                    onConfirm: () => {
                        this.setState({
                            isAutolevelRunning: true,
                            plannedPointCount: 0,
                            probedPoints: []
                        });

                        controller.command('gcode', code.join('\n'));
                        this.setState({ plannedPointCount });
                    }
                }
            });
        },
        doCompensateGcode: () => {
            const {
                delta,
                gcode,
                probedPoints
            } = this.state;

            applyCompensation(gcode, probedPoints, delta);
        },
        doUnloadMesh: () => {
            this.setState(prevState => ({
                gcodeFileName: prevState.gcodeFileNameNext,
                compensatedLoaded: false,
                isAutolevelRunning: false,
                plannedPointCount: 0,
                probedPoints: []
            }));

            controller.command('gcode:stop', { force: true });
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

            if (name.indexOf('#AL:') === 0) {
                this.setState({ compensatedLoaded: true });
                return;
            } else {
                this.setState({ compensatedLoaded: false });
            }

            const { probedPoints } = this.state;

            this.setState({
                gcode,
                gcodeFileNameNext: name,
                gcodeLoaded: true,
            });

            if (probedPoints.length > 0) {
                this.setState({
                    confirmModal: {
                        show: true,
                        title: 'PCB Factory',
                        subtitle: `Do you want to use the current mesh of the file "${this.state.gcodeFileName}"`,
                        onConfirm: () => {
                            this.actions.doUnloadMesh();
                            this.setState({
                                gcodeFileName: name,
                                bbox: calculateBBox(gcode),
                            });
                        }
                    }
                });
            }
        },
        'gcode:unload': () => {
            this.setState({
                gcodeLoaded: false,
                gcode: '',
            });
        },
        'serialport:read': (data) => {
            // TODO: Return a promise? or at the "start level" thing?
            // TODO: Add/remove this listener as needed
            const {
                isAutolevelRunning,
                probedPoints,
                plannedPointCount,
                meshHistory,
                gcodeFileName
            } = this.state;


            if (isAutolevelRunning && probedPoints.length >= plannedPointCount) {
                this.setState({ isAutolevelRunning: false });
                return;
            }

            if (!isAutolevelRunning || plannedPointCount <= 0 || probedPoints.length >= plannedPointCount || data.indexOf('PRB') < 0) {
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

            if (probedPoints.length === 0) {
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

            this.setState(prevState => ({
                probedPoints: [...prevState.probedPoints, pt]
            }));

            log.info(`Probed ${this.state.probedPoints.length}/${this.state.plannedPointCount}> ${pt.x.toFixed(3)} ${pt.y.toFixed(3)} ${pt.z.toFixed(3)}`);

            // send info to console
            if (probedPoints.length >= plannedPointCount) {
                if (meshHistory.length >= 10) {
                    this.setState(prevState => ({ meshHistory: prevState.slice(1) }));
                }

                this.setState(prevState => ({
                    plannedPointCount: 0,
                    meshHistory: [...prevState.meshHistory, {
                        gcodeFileName,
                        probedPoints,
                        timestamp: Date.now()
                    }]
                }));
            }
        }
    }

    getInitialState() {
        return {
            // Internal stuff
            confirmModal: {
                show: false,
                title: 'PCB Factory',
                subtitle: '',
                onConfirm: () => {}
            },

            // Controller
            units: METRIC_UNITS,
            wco: {
                x: 0.000,
                y: 0.000,
                z: 0.000
            },

            // Loaded G-code
            compensatedLoaded: false,
            gcode: '',
            gcodeFileName: '',
            gcodeFileNameNext: '',
            gcodeLoaded: false,

            // Settings
            delta: this.config.get('delta', 10.0),
            feedrate: this.config.get('feedrate', 25),
            margin: this.config.get('margin', 2.5),
            zSafe: this.config.get('zsafe', 2.0),

            // Generated
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
            isAutolevelRunning: false,
            meshHistory: this.config.get('meshhistory', []),
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
            delta,
            feedrate,
            margin,
            zSafe,
            meshHistory
        } = this.state;

        this.config.set('delta', delta);
        this.config.set('feedrate', feedrate);
        this.config.set('margin', margin);
        this.config.set('zsafe', zSafe);
        this.config.set('meshhistory', meshHistory);
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
            confirmModal,

            compensatedLoaded,
            gcodeLoaded,
            gcodeFileName,

            delta,
            feedrate,
            margin,
            zSafe,

            isAutolevelRunning,
            plannedPointCount,
            probedPoints,
        } = this.state;

        const isDisabled = isAutolevelRunning || !gcodeLoaded || gcodeFileName === undefined;

        return (
            <div>
                <div className="form-group">
                    <label className="control-label">{i18n._('Loaded Mesh')}</label>
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
                            value={margin}
                            disabled={isAutolevelRunning}
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
                            value={zSafe}
                            disabled={isAutolevelRunning}
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
                            value={delta}
                            disabled={isAutolevelRunning}
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
                            value={feedrate}
                            disabled={isAutolevelRunning}
                            onChange={actions.onChangeFeedrate}
                        />
                    </div>
                </div>
                <div className="form-group">
                    <div className="btn-group btn-group-sm">
                        <button
                            type="button"
                            className="btn btn-primary"
                            disabled={isDisabled}
                            onClick={actions.doProbeArea}
                        >
                            {i18n._('Start Probing')}
                        </button>
                        <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={isDisabled || compensatedLoaded || probedPoints.length === 0 || plannedPointCount > probedPoints.length}
                            onClick={actions.doCompensateGcode}
                        >
                            {i18n._('Compensate G-code')}
                        </button>
                        <button
                            type="button"
                            className="btn btn-danger"
                            disabled={isAutolevelRunning || probedPoints.length === 0}
                            onClick={actions.doUnloadMesh}
                        >
                            {i18n._('Unload Mesh')}
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
