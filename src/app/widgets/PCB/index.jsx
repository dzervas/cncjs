import PropTypes from 'prop-types';
import React, { PureComponent } from 'react';
import classNames from 'classnames';

import controller from 'app/lib/controller';
import Widget from 'app/components/Widget';
import Space from 'app/components/Space';
import i18n from 'app/lib/i18n';
import {
    // Units
    IMPERIAL_UNITS,
    METRIC_UNITS,
    // Controllers
    GRBL
} from 'app/constants';

import styles from './index.styl';
import AutoLeveler from './AutoLeveler';

class App extends PureComponent {
    static propTypes = {
        widgetId: PropTypes.string.isRequired,
        state: PropTypes.object,
        actions: PropTypes.object,
        sortable: PropTypes.object
    };

    state = this.getInitialState();

    actions = {
        toggleFullscreen: () => {
            const { minimized, isFullscreen } = this.state;
            this.setState(state => ({
                minimized: isFullscreen ? minimized : false,
                isFullscreen: !isFullscreen
            }));
        },
        toggleMinimized: () => {
            const { minimized } = this.state;
            this.setState(state => ({
                minimized: !minimized
            }));
        }
    }

    controllerEvent = {
        'serialport:open': (options) => {
            const { port } = options;
            this.setState({ port: port });
        },
        'serialport:close': (options) => {
            const initialState = this.getInitialState();
            this.setState({ ...initialState });
        },
        'workflow:state': (state, context) => {
            this.setState({
                workflow: {
                    state: state,
                    context: context
                }
            });
        },
        'controller:state': (controllerType, controllerState) => {
            this.setState(state => ({
                controller: {
                    ...state.controller,
                    type: controllerType,
                    state: controllerState
                }
            }));

            if (controllerType === GRBL) {
                const {
                    status: { mpos, wpos, wco },
                    parserstate: { modal = {} }
                } = controllerState;

                // Units
                const units = {
                    'G20': IMPERIAL_UNITS,
                    'G21': METRIC_UNITS
                }[modal.units] || this.state.units;

                this.setState(state => ({
                    units: units,
                    machinePosition: { // Reported in mm ($13=0) or inches ($13=1)
                        ...state.machinePosition,
                        ...mpos
                    },
                    workPosition: { // Reported in mm ($13=0) or inches ($13=1)
                        ...state.workPosition,
                        ...wpos
                    },
                    wco: wco
                }));
            }
        },
        'controller:settings': (controllerType, controllerSettings) => {
            this.setState(state => ({
                controller: {
                    ...state.controller,
                    type: controllerType,
                    settings: controllerSettings
                }
            }));
        }
    };

    componentDidMount() {
        this.addControllerEvents();
    }

    componentWillUnmount() {
        this.removeControllerEvents();
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

    getInitialState() {
        return {
            minimized: false,
            isFullscreen: false,
        };
    }

    render() {
        const { widgetId } = this.props;
        const { minimized, isFullscreen } = this.state;
        const actions = { ...this.actions };
        const isForkedWidget = widgetId.match(/\w+:[\w\-]+/);

        // TODO: Split this in a separate component
        return (
            <Widget fullscreen={isFullscreen}>
                <Widget.Header>
                    <Widget.Title>
                        <Widget.Sortable className={this.props.sortable.handleClassName}>
                            <i className="fa fa-bars" />
                            <Space width="8" />
                        </Widget.Sortable>
                        {isForkedWidget &&
                        <i className="fa fa-code-fork" style={{ marginRight: 5 }} />
                        }
                        {i18n._('PCB Factory')}
                    </Widget.Title>
                    <Widget.Controls className={this.props.sortable.filterClassName}>
                        <Widget.Button
                            disabled={isFullscreen}
                            title={minimized ? i18n._('Expand') : i18n._('Collapse')}
                            onClick={actions.toggleMinimized}
                        >
                            <i
                                className={classNames(
                                    'fa',
                                    'fa-fw',
                                    { 'fa-chevron-up': !minimized },
                                    { 'fa-chevron-down': minimized }
                                )}
                            />
                        </Widget.Button>
                        <Widget.DropdownButton
                            title={i18n._('More')}
                            toggle={<i className="fa fa-ellipsis-v" />}
                            onSelect={(eventKey) => {
                                if (eventKey === 'fullscreen') {
                                    actions.toggleFullscreen();
                                }
                            }}
                        >
                            <Widget.DropdownMenuItem eventKey="fullscreen">
                                <i
                                    className={classNames(
                                        'fa',
                                        'fa-fw',
                                        { 'fa-expand': !isFullscreen },
                                        { 'fa-compress': isFullscreen }
                                    )}
                                />
                                <Space width="4" />
                                {!isFullscreen ? i18n._('Enter Full Screen') : i18n._('Exit Full Screen')}
                            </Widget.DropdownMenuItem>
                        </Widget.DropdownButton>
                    </Widget.Controls>
                </Widget.Header>
                <Widget.Content
                    className={classNames(
                        styles['widget-content'],
                        { [styles.hidden]: minimized }
                    )}
                >
                    <AutoLeveler widgetId={widgetId} />
                </Widget.Content>
            </Widget>
        );
    }
}

export default App;
