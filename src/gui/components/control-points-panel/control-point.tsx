import * as React from 'react'
import Point2D from '../../solver/point-2d'
import { Circle } from 'react-konva'

interface ControlPointProps {
  absolutePosition: Point2D
  fill?: string | undefined
  stroke?: string | undefined
  isDragDisabled?: boolean
  onControlPointDrag(absolutePosition: Point2D): void
}

export default class ControlPoint extends React.Component<ControlPointProps> {
  constructor(props: ControlPointProps) {
    super(props)
  }

  render() {
    return (
      <Circle
        draggable={!this.props.isDragDisabled}
        radius={4}
        strokeWidth={1.5}
        fill={this.props.fill}
        stroke={this.props.stroke}
        x={this.props.absolutePosition.x}
        y={this.props.absolutePosition.y}
        onDragStart={(event: any) => this.handleDrag(event)}
        onDragMove={(event: any) => this.handleDrag(event)}
        onDragEnd={(event: any) => this.handleDrag(event)}
      />
    )
  }

  private handleDrag(event: any) {
    this.props.onControlPointDrag(
      {
        x: event.target.x(),
        y: event.target.y()
      }
    )
  }
}