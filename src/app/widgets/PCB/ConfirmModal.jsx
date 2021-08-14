import PropTypes from 'prop-types';
import React, { PureComponent } from 'react';
import Modal from 'app/components/Modal';
import i18n from 'app/lib/i18n';

class ConfirmModal extends PureComponent {
    static propTypes = {
        onConfirm: PropTypes.func.isRequired,
        onClose: PropTypes.func.isRequired,
        title: PropTypes.string.isRequired,
        subtitle: PropTypes.string.isRequired
    };

    render() {
        const {
            onConfirm,
            onClose,
            title,
            subtitle
        } = this.props;

        return (
            <Modal disableOverlay size="sm" onClose={onClose}>
                <Modal.Header>
                    <Modal.Title>{title}</Modal.Title>
                </Modal.Header>
                <Modal.Body>
                    {subtitle}
                </Modal.Body>
                <Modal.Footer>
                    <button
                        type="button"
                        className="btn btn-default"
                        onClick={onClose}
                    >
                        {i18n._('Cancel')}
                    </button>
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => {
                            onConfirm();
                            onClose();
                        }}
                    >
                        {i18n._('Confirm')}
                    </button>
                </Modal.Footer>
            </Modal>
        );
    }
}

export default ConfirmModal;
